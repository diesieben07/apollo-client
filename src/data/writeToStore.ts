import isArray = require('lodash.isarray');
import isNull = require('lodash.isnull');
import isUndefined = require('lodash.isundefined');
import isObject = require('lodash.isobject');
import assign = require('lodash.assign');

import {
  getQueryDefinition,
  getFragmentDefinition,
  FragmentMap,
} from '../queries/getFromAST';

import {
  storeKeyNameFromField,
  resultKeyNameFromField,
  isField,
  isInlineFragment,
} from './storeUtils';

import {
  OperationDefinition,
  SelectionSet,
  FragmentDefinition,
  Field,
  Document,
} from 'graphql';

import {
  NormalizedCache,
  StoreObject,
  IdValue,
  isIdValue,
} from './store';

import {
  IdGetter,
} from './extensions';

import {
  shouldInclude,
} from '../queries/directives';

// import {
//   printAST,
// } from './debug';

/**
 * Convert a nested GraphQL result into a normalized store, where each object from the schema
 * appears exactly once.
 * @param  {Object} result Arbitrary nested JSON, returned from the GraphQL server
 * @param  {String} [fragment] The GraphQL fragment used to fetch the data in result
 * @param  {SelectionSet} [selectionSet] The parsed selection set for the subtree of the query this
 *                                       result represents
 * @param  {Object} [store] The store to merge into
 * @return {Object} The resulting store
 */
export function writeFragmentToStore({
  result,
  fragment,
  store = {} as NormalizedCache,
  variables,
  dataIdFromObject = null,
}: {
  result: Object,
  fragment: Document,
  store?: NormalizedCache,
  variables?: Object,
  dataIdFromObject?: IdGetter,
}): NormalizedCache {
  // Argument validation
  if (!fragment) {
    throw new Error('Must pass fragment.');
  }

  const parsedFragment: FragmentDefinition = getFragmentDefinition(fragment);
  const selectionSet: SelectionSet = parsedFragment.selectionSet;

  if (!result['id']) {
    throw new Error('Result must have id when writing fragment to store.');
  }

  return writeSelectionSetToStore({
    dataId: result['id'],
    result,
    selectionSet,
    store,
    variables,
    dataIdFromObject,
  });
}

export function writeQueryToStore({
  result,
  query,
  store = {} as NormalizedCache,
  variables,
  dataIdFromObject = null,
}: {
  result: Object,
  query: Document,
  store?: NormalizedCache,
  variables?: Object,
  dataIdFromObject?: IdGetter,
}): NormalizedCache {
  const queryDefinition: OperationDefinition = getQueryDefinition(query);

  return writeSelectionSetToStore({
    dataId: 'ROOT_QUERY',
    result,
    selectionSet: queryDefinition.selectionSet,
    store,
    variables,
    dataIdFromObject,
  });
}

export function writeSelectionSetToStore({
  result,
  dataId,
  selectionSet,
  store = {} as NormalizedCache,
  variables,
  dataIdFromObject,
  fragmentMap,
}: {
  dataId: string,
  result: any,
  selectionSet: SelectionSet,
  store?: NormalizedCache,
  variables: Object,
  dataIdFromObject: IdGetter,
  fragmentMap?: FragmentMap,
}): NormalizedCache {

  if (!fragmentMap) {
    //we have an empty sym table if there's no sym table given
    //to us for the fragments.
    fragmentMap = {};
  }

  selectionSet.selections.forEach((selection) => {
    if (isField(selection)) {
      const resultFieldKey: string = resultKeyNameFromField(selection);
      const value: any = result[resultFieldKey];
      const included = shouldInclude(selection, variables);

      if (isUndefined(value) && included) {
        throw new Error(`Can't find field ${resultFieldKey} on result object ${dataId}.`);
      }

      if (!isUndefined(value) && !included) {
        throw new Error(`Found extra field ${resultFieldKey} on result object ${dataId}.`);
      }

      if (!isUndefined(value)) {
        writeFieldToStore({
          dataId,
          value,
          variables,
          store,
          field: selection,
          dataIdFromObject,
          fragmentMap,
        });
      }
    } else if (isInlineFragment(selection)) {
      // XXX what to do if this tries to write the same fields? Also, type conditions...
      writeSelectionSetToStore({
        result,
        selectionSet: selection.selectionSet,
        store,
        variables,
        dataId,
        dataIdFromObject,
        fragmentMap,
      });
    } else {
      //look up the fragment referred to in the selection
      const fragment = fragmentMap[selection.name.value];
      if (!fragment) {
        throw new Error(`No fragment named ${selection.name.value}.`);
      }

      writeSelectionSetToStore({
        result,
        selectionSet: fragment.selectionSet,
        store,
        variables,
        dataId,
        dataIdFromObject,
        fragmentMap,
      });

      //throw new Error('Non-inline fragments not supported.');
    }
  });

  return store;
}

// Checks if the id given is an id that was generated by Apollo
// rather than by dataIdFromObject.
function isGeneratedId(id: string): boolean {
  return (id[0] === '$');
}

function mergeWithGenerated(generatedKey: string, realKey: string, cache: NormalizedCache) {
  const generated = cache[generatedKey];
  const real = cache[realKey];

  if (!isObject(generated) || !isObject(real)) {
    return;
  }

  Object.keys(generated).forEach((key) => {
    const value = generated[key];
    const realValue = real[key];
    if (isIdValue(value)
        && isGeneratedId(value.id)
        && isIdValue(realValue)) {
      mergeWithGenerated(value.id, realValue.id, cache);
    }
    delete cache[generatedKey];
    cache[realKey] = assign({}, generated, real) as StoreObject;
  });
}

function writeFieldToStore({
  field,
  value,
  variables,
  store,
  dataId,
  dataIdFromObject,
  fragmentMap,
}: {
  field: Field,
  value: any,
  variables: {},
  store: NormalizedCache,
  dataId: string,
  dataIdFromObject: IdGetter,
  fragmentMap?: FragmentMap,
}) {
  let storeValue;

  const storeFieldName: string = storeKeyNameFromField(field, variables);
  // specifies if we need to merge existing keys in the store
  let shouldMerge = false;
  // If we merge, this will be the generatedKey
  let generatedKey: string;

  // If it's a scalar that's not a JSON blob, just store it in the store
  if ((!field.selectionSet || isNull(value)) && !isObject(value)) {
    storeValue = value;
  } else if ((!field.selectionSet || isNull(value)) && isObject(value)) {
    // If it is a scalar that's a JSON blob, we have to "escape" it so it can't
    // pretend to be an id
    storeValue = {
      type: 'json',
      json: value,
    };
  } else if (isArray(value)) {
    // this is an array with sub-objects
    const thisIdList: Array<string> = [];

    value.forEach((item, index) => {
      if (isNull(item)) {
        thisIdList.push(null);
      } else {
        let itemDataId = `${dataId}.${storeFieldName}.${index}`;

        if (dataIdFromObject) {
          const semanticId = dataIdFromObject(item);

          if (semanticId) {
            itemDataId = semanticId;
          }
        }

        thisIdList.push(itemDataId);

        writeSelectionSetToStore({
          dataId: itemDataId,
          result: item,
          store,
          selectionSet: field.selectionSet,
          variables,
          dataIdFromObject,
          fragmentMap,
        });
      }
    });

    storeValue = thisIdList;
  } else {
    // It's an object
    let valueDataId = `${dataId}.${storeFieldName}`;
    let generated = true;

    // We only prepend the '$' if the valueDataId isn't already a generated
    // id.
    if (!isGeneratedId(valueDataId)) {
      valueDataId = '$' + valueDataId;
    }

    if (dataIdFromObject) {
      const semanticId = dataIdFromObject(value);

      // We throw an error if the first character of the id is '$. This is
      // because we use that character to designate an Apollo-generated id
      // and we use the distinction between user-desiginated and application-provided
      // ids when managing overwrites.
      if (semanticId && isGeneratedId(semanticId)) {
        throw new Error('IDs returned by dataIdFromObject cannot begin with the "$" character.');
      }

      if (semanticId) {
        valueDataId = semanticId;
        generated = false;
      }
    }

    writeSelectionSetToStore({
      dataId: valueDataId,
      result: value,
      store,
      selectionSet: field.selectionSet,
      variables,
      dataIdFromObject,
      fragmentMap,
    });

    // We take the id and escape it (i.e. wrap it with an enclosing object).
    // This allows us to distinguish IDs from normal scalars.
    storeValue = {
      type: 'id',
      id: valueDataId,
      generated,
    };

    // check if there was a generated id at the location where we're
    // about to place this new id. If there was, we have to merge the
    // data from that id with the data we're about to write in the store.
    if (store[dataId] && store[dataId][storeFieldName] !== storeValue) {
      const escapedId = store[dataId][storeFieldName] as IdValue;
      if (isIdValue(escapedId) && isGeneratedId(escapedId.id)) {
        generatedKey = escapedId.id as string;
        shouldMerge = true;
      }
    }
  }

  const newStoreObj = assign({}, store[dataId], {
    [storeFieldName]: storeValue,
  }) as StoreObject;

  if (shouldMerge) {
    mergeWithGenerated(generatedKey, (storeValue as IdValue).id, store);
  }
  if (!store[dataId] || storeValue !== store[dataId][storeFieldName]) {
    store[dataId] = newStoreObj;
  }

}

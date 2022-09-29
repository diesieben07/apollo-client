import '../globals'; // For __DEV__
import { isNonNullObject } from './objects';

function deepFreeze(value: any) {
  const workSet = new Set([value]);
  workSet.forEach(obj => {
    if (isNonNullObject(obj) && !isMarkedImmutable(obj) && shallowFreeze(obj) === obj) {
      Object.getOwnPropertyNames(obj).forEach(name => {
        if (isNonNullObject(obj[name])) workSet.add(obj[name]);
      });
    }
  });
  return value;
}

function isMarkedImmutable(obj: any): boolean {
  return obj[isImmutable] || obj.constructor?.[isImmutable];
}

function shallowFreeze<T extends object>(obj: T): T | null {
  if (!Object.isFrozen(obj)) {
    try {
      Object.freeze(obj);
    } catch (e) {
      // Some types like Uint8Array and Node.js's Buffer cannot be frozen, but
      // they all throw a TypeError when you try, so we re-throw any exceptions
      // that are not TypeErrors, since that would be unexpected.
      if (e instanceof TypeError) return null;
      throw e;
    }
  }
  return obj;
}

export const isImmutable = Symbol('isImmutable');

export function maybeDeepFreeze<T>(obj: T): T {
  if (__DEV__) {
    deepFreeze(obj);
  }
  return obj;
}

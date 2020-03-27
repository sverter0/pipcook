'use strict';

const util = require('util');
const native = require('bindings')('boa');
const debug = require('debug')('boa');
const utils = require('./utils');
const DelegatorLoader = require('./delegator-loader');

// internal symbols
const IterIdxForSeqSymbol = Symbol('The iteration index for sequence');

// create the instance
let pyInst = new native.Python(process.argv.slice(1));
const globals = pyInst.globals();
const builtins = _internalWrap(pyInst.builtins());
const delegators = DelegatorLoader.load();

function getTypeInfo(T) {
  const typeo = builtins.__getitem__('type').invoke(asHandleObject(T));
  return {
    module: typeo.__getattr__('__module__').toString(),
    name: typeo.__getattr__('__name__').toString(),
  };
}

// shadow copy an object, and returns the new copied object.
function copy(T) {
  const fn = pyInst.import('copy').__getattr__('copy');
  return fn.invoke(asHandleObject(T));
}

function getDelegator(type) {
  if (typeof type === 'string') {
    return delegators[type];
  }
  const { module, name } = type;
  if (Object.prototype.hasOwnProperty.call(delegators, module)) {
    return delegators[module][name];
  }
  return undefined;
}

// The function `wrap(T)` is used to return an object or value for using.
// It depends on the type of `T` in Python world, usually it returns a 
// `Proxy` object that's based on `T`, when the type could be represented
// as number/boolean/string/null, the return value would be converted to
// corresponding JS primative.
function wrap(T) {
  // if `T` is null or undefined, returning itself by default.
  if (T === null || T == undefined) {
    return T;
  }

  const type = getTypeInfo(T);
  debug(`start wrapping an object, and its type is "${type.module}.${type.name}"`);

  // if `type` is "NoneType", returning the null.
  if (type.module === 'builtins' && type.name === 'NoneType') {
    return null;
  }

  // FIXME(Yorkie): directly returning the primitive value on the 
  // following conditions.
  if ([
    /** python types convert to primitive values. */
    'int',  /** Number */
    'int64', /** BigInt */
    'float', /** Number */
    'float64', /** BigDecimal(depends on new tc39 proposal) */
    'bool', /** Boolean */
    'str', /** String */
    /** except for null and undefined */
  ].includes(type.name)) {
    return T.toPrimitive();
  }

  let fn = getDelegator(T.isCallable() ? 'callee' : type);
  if (typeof fn !== 'function') {
    fn = getDelegator('default');
  }
  // use internalWrap to generate proxy object with corresponding delegator.
  const wrapped = _internalWrap(T, fn(T, wrap));
  T[native.NODE_PYTHON_WRAPPED_NAME] = wrapped;
  return wrapped;
}

function asHandleObject(T) {
  return {
    // namely shortcut for Python object.
    [native.NODE_PYTHON_HANDLE_NAME]: T
  };
}

function asBytesObject(str) {
  return {
    [native.NODE_PYTHON_VALUE_NAME]: str,
    [native.NODE_PYTHON_BYTES_NAME]: true,
  };
}

function _internalWrap(T, src={}) {
  Object.defineProperties(src, {
    /**
     * @property native.NODE_PYTHON_WRAPPED_NAME
     * @private
     */
    [native.NODE_PYTHON_HANDLE_NAME]: {
      enumerable: true,
      writable: false,
      value: T,
    },
    /**
     * @method native.NODE_PYTHON_JS_DISPATCH
     * @private
     */
    [native.NODE_PYTHON_JS_DISPATCH]: {
      enumerable: true,
      // FIXME(Yorkie): temporarily set `configurable` to false here.
      // See https://github.com/v8/v8/blob/7.9.317/src/objects/objects.cc#L1176-L1179
      //
      // The proxy object's get trap handler is inconsistent with this descriptor when
      // the value is a function, which means the `inconsistent` to be true, then throwing
      // a `kProxyGetNonConfigurableData` error.
      //
      // In order to better solve, we need to define both `get` and `has` traps in the
      // proxy object, and move descriptors to the trap handler.
      configurable: true,
      writable: false,
      value: function(fn, ...args) {
        return fn.apply(this, args.map(wrap));
      },
    },
    /**
     * @method invoke
     * @param {object} args
     * @private
     */
    invoke: {
      enumerable: false,
      writable: false,
      value: args => T.invoke.apply(T, args),
    },
    /**
     * @method toString
     * @public
     */
    toString: {
      configurable: true,
      enumerable: false,
      writable: false,
      value: () => T.toString(),
    },
    /**
     * Shortcut for slicing object.
     * @method slice
     * @public
     */
    slice: {
      configurable: true,
      enumerable: false,
      writable: false,
      value: (start, end, step) => {
        // slice(start, end, step)
        const slice = builtins.__getitem__('slice')
          .invoke(start, end, step);
        // use the slice object as the key for s[x:y:z]
        return wrap(T.__getitem__(asHandleObject(slice)));
      },
    },
    /**
     * This is used to cusom the console.log output by calling toString().
     * @method util.inspect.custom
     * @public
     */
    [util.inspect.custom]: {
      configurable: true,
      enumerable: false,
      writable: false,
      value: () => T.toString(),
    },
    /**
     * @method Symbol.toPrimitive
     * @param {string} hint
     * @public
     */
    // Forward compatible with newer `toPrimitive` spec
    // See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/toPrimitive
    [Symbol.toPrimitive]: {
      configurable: true,
      enumerable: false,
      writable: false,
      // eslint-disable-next-line no-unused-vars
      value: hint => T.toString(),
    },
    /**
     * Implementation of ES iterator protocol, See:
     *   https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols
     *
     * @method Symbol.iterator
     * @public
     */
    [Symbol.iterator]: {
      configurable: true,
      enumerable: false,
      writable: false,
      value: () => {
        if (T.isIterator()) {
          return {
            next: () => {
              const curr = T.next();
              return {
                done: curr.done,
                value: wrap(curr.value),
              };
            },
          };
        }
        if (T.isSequence()) {
          return {
            next: function next() {
              if (typeof this[IterIdxForSeqSymbol] === 'number') {
                this[IterIdxForSeqSymbol] += 1;
              } else {
                this[IterIdxForSeqSymbol] = 0;
              }
              const lengthOfSeq = builtins.__getitem__('len')
                .invoke(asHandleObject(T)).toPrimitive();
              const index = this[IterIdxForSeqSymbol];
              if (index >= lengthOfSeq) {
                return { done: true, value: undefined };
              }
              return {
                done: false,
                value: wrap(T.__getitem__(index)),
              };
            }
          };
        }
        throw new TypeError('object is not iteratable or sequence.');
      },
    },
    // The following are magic methods by Python
    /**
     * @method __hash__
     * @public
     */
    __hash__: {
      configurable: true,
      enumerable: true,
      writable: false,
      value: () => T.__hash__(),
    },
    /**
     * @method __hasattr__
     * @param {string} name
     * @private
     */
    __hasattr__: {
      configurable: true,
      enumerable: true,
      writable: false,
      value: n => T.__hasattr__(n),
    },
    /**
     * @method __getattr__
     * @param {string} name
     * @private
     */
    __getattr__: {
      configurable: true,
      enumerable: true,
      writable: false,
      value: n => T.__getattr__(n),
    },
    /**
     * @method __getitem__
     * @param {string|number} key
     * @private
     */
    __getitem__: {
      configurable: true,
      enumerable: true,
      writable: false,
      value: k => T.__getitem__(k),
    },
    /**
     * @method __setattr__
     * @param {string} name
     * @param {object} value
     * @private
     */
    __setattr__: {
      configurable: true,
      enumerable: true,
      writable: false,
      value: (n, v) => T.__setattr__(n, v),
    },
    /**
     * @method __setitem__
     * @param {string} key
     * @param {object} value
     * @private
     */
    __setitem__: {
      configurable: true,
      enumerable: true,
      writable: false,
      value: (k, v) => T.__setitem__(k, v),
    },
  });

  // Create the proxy object for handlers
  let newTarget;
  return (newTarget = new Proxy(src, {
    'get'(target, name) {
      debug(`get property on "${target.constructor.name}", ` +
            `name is "${name.toString()}"`);

      const { hasOwnProperty } = Object.prototype;
      const constructProto = target.constructor.prototype;
      if (hasOwnProperty.call(target, name) /* check for own property */ ||
        hasOwnProperty.call(constructProto, name) /* check for inherited one-level */
      ) {
        const value = target[name];
        debug(`found "${name.toString()}" from object own properties ` +
              `or one-level properties.`);

        if (typeof value === 'function') {
          // FIXME(Yorkie): make sure the function's this is correct.
          return value.bind(newTarget);
        } else {
          return value;
        }
      }

      /** Enter the Python world. */
      if (typeof name === 'string') {
        if (/^[0-9]+$/.test(name)) {
          debug('name is detected to be an index.');
          const n = parseInt(name, 10);
          return wrap(target.__getitem__(n));
        }
        if (target.__hasattr__(name)) {
          debug(`found "${name}" as python attr`);
          return wrap(target.__getattr__(name));
        }
      }

      try {
        const r = target.__getitem__(name);
        if (r != null) {
          debug(`found "${name.toString()}" as python item`);
          return wrap(r);
        }
      } catch (e) {
        debug(`accessing the item["${name.toString()}"] failed ` +
              `with ${e.message}`);
      }
    },
    'set'(target, name, value) {
      if (typeof name === 'string') {
        if (/^[0-9]+$/.test(name)) {
          return target.__setitem__(parseInt(name, 10), value) !== -1;
        }
        if (target.__hasattr__(name)) {
          return target.__setattr__(name, value) !== -1;
        }
      }
      let r = target.__setitem__(name, value);
      if (r === -1) {
        r = target.__setattr__(name, value);
      }
      return r !== -1;
    },
    'apply'(target, thisArg, argumentsList) {
      return wrap(target.invoke(argumentsList));
    },
    'construct'(target, argumentsList, newClass) {
      const obj = wrap(target.invoke(argumentsList));
      // call Python's constructor function `__init__`.
      // TODO(Yorkie): with arguments?
      obj.__init__();

      // register the declared methods & members
      Object.getOwnPropertyNames(newClass.prototype)
        .filter(name => {
          return name !== 'constructor';
        })
        .forEach(name => {
          obj.__setattr__(name, newClass.prototype[name]);
        });
      return obj;
    },
  }));
}

module.exports = {
  /*
   * Import a Python module.
   * @method import
   * @param {string} mod - the module path.
   */
  'import': mod => wrap(pyInst.import(mod)),
  /*
   * Get the builtins
   * @method builtins
   */
  'builtins': () => builtins,
  /**
   * Create a bytes object.
   * @method bytes
   * @param {string|Buffer|TypedArray} data - the input data.
   */
  'bytes': data => asBytesObject(data),
  /**
   * Create a keyword arguments objects.
   * @method kwargs
   * @param {object} input - the kwargs input.
   */
  'kwargs': input => {
    if (typeof input !== 'object') {
      throw new TypeError('input must be a string.');
    }
    return Object.assign({}, input, {
      [native.NODE_PYTHON_KWARGS_NAME]: true,
    });
  },
  /**
   * With-statement function, See:
   * https://docs.python.org/3/reference/compound_stmts.html#the-with-statement
   * @method with
   * @param {function} fn
   */
  'with': (ctx, fn) => {
    if (typeof ctx.__enter__ !== 'function' ||
      typeof ctx.__exit__ !== 'function') {
      throw new TypeError('the context object must have the ' +
                          'magic methods: `__enter__`, `__exit__`.');
    }
    if (typeof fn !== 'function') {
      // FIXME(Yorkie): should call __exit__ before throwing the error.
      ctx.__exit__(null, null, null);
      throw new TypeError('the `fn` must be a function.');
    }
    return (async () => {
      let hitException = false;
      try {
        await fn(ctx.__enter__());
      } catch (err) {
        hitException = true;
        if (!ctx.__exit__(
            asHandleObject(err.ptype),
            asHandleObject(err.pvalue),
            asHandleObject(err.ptrace))) {
          // TODO(Yorkie): throw an new error that hides python objects?
          throw err;
        }
      } finally {
        if (!hitException) {
          ctx.__exit__(null, null, null);
        }
      }
    })();
  },
  'eval': (strs, ...params) => {
    let src = '';
    let env = globals;
    if (typeof strs === 'string') {
      src = strs
    } else if (strs.length === 1) {
      [src] = strs;
    } else {
      let idx = 0;
      env = copy(globals);
      src = strs.reduce((acc, str) => {
        let next = acc
        next += str;
        if (idx < params.length) {
          const k = `boa_eval_var_${idx}`;
          const v = params[idx];
          env.__setitem__(k, v);
          next += k;
          idx += 1;
        }
        return next;
      }, src);
    }
    // for multiline executing.
    const lines = src.split('\n').filter(utils.notEmpty);
    const indent = utils.getIndent(lines);
    return wrap(pyInst.eval(
      lines.map(utils.removeIndent(indent)).join('\n'),
      { globals: env, locals: env }
    ));
  },
};

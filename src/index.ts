import create, { StateCreator, State, StateSelector, EqualityChecker, SetState, GetState, Subscribe, Destroy, StoreApi } from 'zustand';
import shallow from 'zustand/shallow';
import flow from 'lodash/flow';

type TStateRecords = Record<string | number | symbol | any, any>

export enum LogLevel {
  None = 'none',
  Diff = 'diff',
  All = 'all'
}

interface IAddonsSettings {
  name?: string,
  logLevel?: LogLevel | string
}

// type MiddlewareNodeStateCreator
// type MiddlewareNode = <TState extends TStateRecords>() => StateCreator<TState> | (config: any) => (set: any, get: any, api: any) => any;

interface IAddons {
  computed?: TStateRecords,
  watchers?: TStateRecords,
  middleware?: Array<any>,
  settings?: IAddonsSettings
}

function getDeps(fn: (state: State) => any) {
  const reg = new RegExp(/(?:this\.)(\w+)/g);
  const reg2 = new RegExp(/(?:this\[')(\w+)(?:'\])/g);
  const matches = Array.from(fn.toString().matchAll(reg));
  const matches2 = Array.from(fn.toString().matchAll(reg2));
  return Array.from(new Set([...matches, ...matches2])).map(
    (match) => match[1]
  );
}

function intersection(aArray: any[], bArray: any) {
  let intersections = [];
  for (let elem of bArray) {
    if (aArray.includes(elem)) {
      intersections.push(elem);
    }
  }
  return intersections;
}

export interface UseStore<T extends State> {
  (): T
  <U>(selector: StateSelector<T, U> | string, equalityFn?: EqualityChecker<U>): U
  setState: SetState<T>
  getState: GetState<T>
  subscribe: Subscribe<T>
  destroy: Destroy
}

export default function createStore <TState extends TStateRecords>(
  stateInitializer: StateCreator<TState>,
  addons?: IAddons
): UseStore<TState> {

  let _api: StoreApi<TState>;
  let _originalSetState: SetState<TState>;
  let _computed: TStateRecords = {};
  let _computedPropDependencies: TStateRecords = {};
  let _watchers: TStateRecords = {};
  let _settings: IAddonsSettings = {
    name: addons?.settings?.name ?? 'MyStore',
    logLevel: addons?.settings?.logLevel ?? LogLevel.None
  }

  function attachMiddleWare(config: StateCreator<TState>) {
    return (set: SetState<TState>, get: GetState<TState>, api: StoreApi<TState>) => {
      return config((args: any, setSettings: any) => {
        return setMiddleware([args, setSettings], set)
      }
      , get, api)
    };
  };

  function setState(args: any, setSettings: any) {
    setMiddleware([args, setSettings], _originalSetState);
  };

  function setMiddleware(args: any, set: any) {
    const [partialState, setSettings] = args;

    const logOperations = (!setSettings?.excludeInLogs ?? true) && <string>_settings.logLevel !== <string>LogLevel.None;

    const currentState = _api.getState();
    const changes = typeof partialState === 'function' ? partialState(currentState) : partialState;

    const group = `${_settings.name} state changed`
    logOperations && console.group(group)
    logOperations && <string>_settings.logLevel === <string>LogLevel.All && console.log('Previous State', currentState)
    logOperations && console.log('Applying', changes);

    let updatedComputed:Record<string | number | symbol, any> = {};

    for (const [compPropName, compPropDeps] of Object.entries(_computedPropDependencies)) {
      const needsRecompute = intersection(Object.keys(changes), compPropDeps);
      if (needsRecompute.length > 0) {
        updatedComputed[compPropName] = _computed[compPropName].apply({
          ...currentState,
          ...changes,
          ...updatedComputed
        });
      }
    }

    if (Object.keys(updatedComputed).length > 0) {
      logOperations && console.log('Updating computed values', updatedComputed);
    }

    const newState = { ...changes, ...updatedComputed };
    set(newState);

    for (const [propName, fn] of Object.entries(_watchers)) {
      if (Object.keys(newState).includes(propName)) {
        logOperations && console.log(`Triggering watcher: ${propName}`)
        fn.apply({ set: _api.setState, get: _api.getState, api: _api }, [
          newState[propName],
          currentState[propName]
        ]);
      }
    }

    logOperations && <string>_settings.logLevel === <string>LogLevel.All && console.log('New State', _api.getState())
    logOperations && console.groupEnd()
  };

  const middlewareFunctions = (
    middleware: Array<<TState extends TStateRecords>() => StateCreator<TState>> | undefined,
    store: StateCreator<TState>
  ) => middleware ? flow(middleware)(store) : store;

  function configComputed(computed: TStateRecords) {
    let computedToAdd = {};
    for (const [key, value] of Object.entries(computed)) {
      const deps = getDeps(value);
      if (deps.length > 0) {
        _computedPropDependencies[key] = deps;
        _computed[key] = value;
      }
      computedToAdd = {
        ...computedToAdd,
        [key]: value.apply({ ..._api.getState(), ...computedToAdd })
      };
    }
    if (Object.keys(computedToAdd).length > 0) {
      _api.setState(computedToAdd);
    }
  };

  function configWatchers(watchers: TStateRecords) {
    for (const [propName, fn] of Object.entries(watchers)) {
      _watchers[propName] = fn;
    }
  };

  const hook = create(
    attachMiddleWare(
      middlewareFunctions(
        addons?.middleware,
        <TState extends State>(set: SetState<TState>, get: GetState<TState>, api: StoreApi<TState>
      ) => {
        _api = api;
        _originalSetState = {...api}.setState;
        _api.setState = setState;
        return {...stateInitializer(set, get, api)}
      })
    )
  );

  const stateHook: any = (selector: any, equalityFn?: any) => {
    if (typeof selector === "string") {
      if (selector.indexOf(",") !== -1) {
        const props = selector.split(",").map((part) => part.trim());
        return hook((state) => props.map((prop) => state[prop]), shallow);
      }
      return hook((state) => state[selector], equalityFn);
    }
    return hook(selector, equalityFn);
  }

  // @ts-ignore
  Object.assign(stateHook, _api);

  configComputed(addons?.computed ?? {});
  configWatchers(addons?.watchers ?? {});

  return stateHook;
}
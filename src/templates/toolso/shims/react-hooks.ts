// Static stand-ins for React hooks. Components render once, on the server, in their initial
// state; src/ui/toolso.js adds the interactivity. Real hooks are unavailable: the Next build
// resolves `react` to the react-server build, and no hydration ever runs these components.
let ids = 0;
export const resetIds = () => {
  ids = 0;
};
export const useState = <T,>(initial: T | (() => T)) =>
  [typeof initial === "function" ? (initial as () => T)() : initial, () => {}] as const;
export const useReducer = <S,>(_reducer: unknown, initial: S) => [initial, () => {}] as const;
export const useEffect = (_effect: unknown, _deps?: unknown) => {};
export const useLayoutEffect = useEffect;
export const useRef = <T,>(initial: T | null = null) => ({ current: initial });
export const useMemo = <T,>(factory: () => T, _deps?: unknown) => factory();
export const useCallback = <T,>(callback: T, _deps?: unknown) => callback;
export const useTransition = () => [false, (run: () => void) => run()] as const;
export const useId = () => `t${++ids}`;

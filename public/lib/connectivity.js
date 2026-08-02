export function isConnectivityFailure(error, navigatorRef = globalThis.navigator) {
  return navigatorRef?.onLine === false || error instanceof TypeError;
}

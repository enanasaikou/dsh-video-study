export const LIVE_FIELDS = Object.freeze([
  'mode', 'defaultLanguage', 'pythonPath', 'stateDir', 'outputDir', 'documentOutputDir', 'documentFormat',
  'localModel', 'localModelDir', 'localDevice', 'localComputeType',
  'cloudProviderName', 'cloudProtocol', 'cloudResponseFormat', 'cloudAppId', 'cloudRegion', 'cloudResourceId',
  'cloudEndpoint', 'cloudApiKey', 'cloudApiKeyFile', 'cloudModel', 'cloudUploadConsent',
  'allowInsecureLoopback', 'cloudMaxAudioMiB', 'proxy', 'downloadTimeout', 'asrTimeout', 'maxDuration',
]);

// Native volatile Config fields are live refs. Resolve only the field being
// consumed: eager spreading/snapshotting would read unrelated cloud secrets.
export function configValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get() : value;
}

export function liveConfig(config = {}) {
  return new Proxy(config, {
    get(target, property, receiver) { return configValue(Reflect.get(target, property, receiver)); },
  });
}

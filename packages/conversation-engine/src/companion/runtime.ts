export const CORE_VERSION = '0.1.2-core2';
export const CORE_ID = 'aladushek04/companion-core';
/** Panel's bundled runtime and LM Studio's plugin runner are separate processes. */
export function supportedCoreRuntime(version: string): boolean { return /^v?(24|25)\.\d+\.\d+(?:[-+].*)?$/.test(version); }

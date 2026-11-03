export const SUPPORTED_MAJORS = [24, 25];

export function isSupportedNode(version) {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  return SUPPORTED_MAJORS.includes(major);
}

export function supportedNodeMessage(version) {
  return `Node ${version} не поддерживается. Нужен Node 24.22.2 (см. .nvmrc; Node 25 тоже проверен).`;
}

import { isSupportedNode, supportedNodeMessage } from './lib/node-version.mjs';

if (!isSupportedNode(process.version)) {
  console.error(supportedNodeMessage(process.version));
  process.exit(1);
}

console.log(`Node ${process.version} — OK`);

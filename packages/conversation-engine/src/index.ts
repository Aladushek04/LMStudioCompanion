import { PluginContext } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { predictionLoopHandler } from "./handler";

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withPredictionLoopHandler(predictionLoopHandler);
}

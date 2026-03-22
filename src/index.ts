import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "./api.js";
import { parsePluginConfig } from "./src/types.js";
import type { WorkerIdentity } from "./src/types.js";
import { buildConfigSchema } from "./src/config.js";
import { loadTeamState } from "./src/state.js";
import { createWorkerService } from "./src/worker/worker-service.js";
import { createWorkerPromptInjector } from "./src/worker/prompt-injector.js";
import { createWorkerTools } from "./src/worker/tools.js";
import { MessageQueue } from "./src/worker/message-queue.js";
import { getRole } from "./src/roles.js";
import { createControllerService } from "./src/controller/controller-service.js";
import { createControllerPromptInjector } from "./src/controller/prompt-injector.js";
import { createControllerTools } from "./src/controller/controller-tools.js";

export default definePluginEntry({
  id: "teamclaw",
  name: "TeamClaw",
  description:
    "Virtual team collaboration - multiple OpenClaw instances form a virtual software company with role-based task routing.",
  configSchema: buildConfigSchema(),
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig as Record<string, unknown>);
    const logger = api.logger;

    if (config.mode === "controller") {
      registerController(api, config);
    } else {
      registerWorker(api, config);
    }
  },
});

function registerController(api: OpenClawPluginApi, config: ReturnType<typeof parsePluginConfig>) {
  const logger = api.logger;

  // Service (starts HTTP server + mDNS + WebSocket)
  api.registerService(createControllerService({ config, logger }));

  // Prompt injection
  api.on("before_prompt_build", async () => {
    const state = await loadTeamState(config.teamName);
    const injector = createControllerPromptInjector({
      config,
      getTeamState: () => state,
    });
    return injector() ?? {};
  });

  // Tools - register all controller tools via factory returning an array
  const controllerUrl = `http://localhost:${config.port}`;
  api.registerTool(() => {
    const tools = createControllerTools({
      config,
      controllerUrl,
      getTeamState: () => null,
    });
    return tools;
  });
}

function registerWorker(api: OpenClawPluginApi, config: ReturnType<typeof parsePluginConfig>) {
  const logger = api.logger;
  const messageQueue = new MessageQueue();
  let currentControllerUrl: string | null = null;
  let currentWorkerId: string | null = null;

  function getIdentity(): WorkerIdentity | null {
    if (!currentWorkerId || !currentControllerUrl) return null;
    return {
      workerId: currentWorkerId,
      role: config.role,
      controllerUrl: currentControllerUrl,
      registeredAt: Date.now(),
    };
  }

  // Build role-specific system prompt for task execution
  const roleDef = getRole(config.role);
  const roleSystemPrompt = roleDef
    ? roleDef.systemPrompt
    : `You are a ${config.role} in a virtual software team. Complete the assigned task.`;

  // Task executor: uses OpenClaw's subagent to run LLM agent for each task
  const taskExecutor = async (taskDescription: string, taskId: string): Promise<string> => {
    const sessionKey = `teamclaw-task-${taskId}`;
    logger.info(`Worker: executing task ${taskId} via subagent`);

    try {
      const runResult = await api.runtime.subagent.run({
        sessionKey,
        message: taskDescription,
        extraSystemPrompt: roleSystemPrompt,
        idempotencyKey: `teamclaw-${taskId}`,
      });

      logger.info(`Worker: subagent run started for task ${taskId}, runId=${runResult.runId}`);

      const waitResult = await api.runtime.subagent.waitForRun({
        runId: runResult.runId,
        timeoutMs: 300_000, // 5 minute timeout
      });

      if (waitResult.status === "ok") {
        // Extract the last assistant message as the result
        const sessionMessages = await api.runtime.subagent.getSessionMessages({
          sessionKey,
          limit: 5,
        });

        // Find the last assistant message content
        const assistantMessages = sessionMessages.messages.filter(
          (m: { role?: string }) => m.role === "assistant",
        );
        const lastAssistant = assistantMessages[assistantMessages.length - 1];

        // Extract text content from the last assistant message
        let result = "";
        if (lastAssistant) {
          const content = (lastAssistant as { content?: unknown }).content;
          if (typeof content === "string") {
            result = content;
          } else if (Array.isArray(content)) {
            // Content blocks: [{ type: "text", text: "..." }, { type: "thinking", thinking: "..." }]
            const textBlocks = content
              .filter((b: { type?: string }) => b.type === "text")
              .map((b: { text?: string }) => b.text ?? "");
            result = textBlocks.join("\n");
          }
          if (!result) {
            result = JSON.stringify(lastAssistant);
          }
        }

        logger.info(`Worker: task ${taskId} completed successfully`);
        return result;
      } else if (waitResult.status === "timeout") {
        throw new Error("Task execution timed out after 5 minutes");
      } else {
        throw new Error(waitResult.error || "Task execution failed");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Worker: task ${taskId} execution failed: ${errorMsg}`);
      throw err;
    }
  };

  // Service
  api.registerService(
    createWorkerService({
      config,
      logger,
      onIdentityEstablished: (identity) => {
        currentControllerUrl = identity.controllerUrl;
        currentWorkerId = identity.workerId;
      },
      taskExecutor,
    }),
  );

  // Prompt injection
  api.on("before_prompt_build", async () => {
    const injector = createWorkerPromptInjector(config, getIdentity, messageQueue);
    return injector() ?? {};
  });

  // Tools - register all worker tools via factory returning an array
  api.registerTool(() => {
    return createWorkerTools({ config, getIdentity });
  });
}

function defaultOutputIsUsable(output, existsSync) {
  if (!output || typeof output !== 'object') return output !== undefined;
  const paths = Object.entries(output)
    .filter(([key, value]) => /path$/i.test(key) && typeof value === 'string' && value)
    .map(([, value]) => value);
  return paths.length === 0 || paths.every((filePath) => existsSync(filePath));
}

function createRenderOrchestrator({ store, existsSync, logger = console }) {
  if (!store || typeof store.saveTask !== 'function') {
    throw new TypeError('Render orchestrator cần một job store');
  }

  async function runStage(task, stageName, runner, options = {}) {
    task.stages ||= {};
    const previous = task.stages[stageName];
    const validate = options.validate || ((output) => defaultOutputIsUsable(output, existsSync));

    if (previous?.status === 'success' && validate(previous.output)) {
      logger.log(`[Render Stage] Bỏ qua ${stageName}, dùng checkpoint đã hoàn tất.`);
      task.currentStage = stageName;
      return previous.output;
    }

    task.currentStage = stageName;
    task.stages[stageName] = {
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      output: null
    };
    store.saveTask(task);

    try {
      const output = await runner();
      task.stages[stageName] = {
        ...task.stages[stageName],
        status: 'success',
        completedAt: new Date().toISOString(),
        output: output === undefined ? null : output
      };
      store.saveTask(task);
      return output;
    } catch (error) {
      task.stages[stageName] = {
        ...task.stages[stageName],
        status: 'error',
        completedAt: new Date().toISOString(),
        error: error.message
      };
      store.saveTask(task);
      throw error;
    }
  }

  function markStage(task, stageName) {
    task.currentStage = stageName;
    store.saveTask(task);
  }

  return { runStage, markStage };
}

module.exports = {
  createRenderOrchestrator,
  defaultOutputIsUsable
};

function makeTraceId(runId, stepN) {
  if (!runId || stepN == null) throw new Error('makeTraceId requires runId and stepN');
  return `${runId}:${stepN}`;
}

module.exports = { makeTraceId };

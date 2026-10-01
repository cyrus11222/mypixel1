// The Minecraft server protocol has not been configured yet. Approval is kept
// separate from execution so a web approval never claims that items were sent.
export function executionConfiguration() {
  return { configured: false, message: 'Minecraft 服务器执行接口尚未接入；审批通过后等待执行。' };
}
export function pendingExecution() {
  return { status: 'pending_configuration', message: '审批已通过，等待配置 Minecraft 服务器执行接口；尚未发放权限或物资。' };
}

const { getAuthorizedAccountId, requireConnectedAccount } = require('./admin-activity-route-helpers');

const MILK_TEA_OPERATE_ACTIONS = ['exchange', 'daily', 'milestones'];

function registerAdminMilkTeaActivityRoutes({ app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError }) {
  const context = { getAccountIdFromRequest, canAccessAccount };
  app.get('/api/activity/milk-tea', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, context);
    if (!accountId) return;
    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取活动失败: 账号未运行')) return;
      res.json({ ok: true, activity: await provider.getMilkTeaActivity(accountId) });
    } catch (error) { sendProviderError(res, error); }
  });
  app.post('/api/activity/milk-tea/operate', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, context);
    if (!accountId) return;
    const action = String(req.body?.action || '');
    if (!MILK_TEA_OPERATE_ACTIONS.includes(action)) return res.status(400).json({ ok: false, error: '活动操作无效' });
    try {
      if (!requireConnectedAccount(res, provider, accountId, '活动操作失败: 账号未运行')) return;
      const params = { slotId: Number(req.body?.slotId) || 0, count: Number(req.body?.count) || 1 };
      res.json(await provider.operateMilkTea(accountId, action, params));
    } catch (error) { sendProviderError(res, error); }
  });
}

module.exports = { registerAdminMilkTeaActivityRoutes };

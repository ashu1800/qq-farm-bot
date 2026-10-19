function registerAdminSystemRoutes({
  app,
  store,
  logger,
  requireAdminToken,
  requireAdminRole,
  requireDangerConfirmation,
  getDefaultSystemConfig,
  getRuntimeConfig,
  updateRuntimeConfig,
}) {
  app.get(
   "/api/admin/system-config",
    requireAdminToken,
    requireAdminRole,
    (req, res) => {
      try {
        res.json({
          ok: true,
          data: {
            saved: store.getSystemConfig(),
            default: getDefaultSystemConfig(),
            current: getRuntimeConfig(),
          },
        });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    },
  );

  app.get("/api/public/login-links", (req, res) => {
    try {
      res.json({ ok: true, data: store.getLoginLinks() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post(
   "/api/admin/system-config",
    requireAdminToken,
    requireAdminRole,
    (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "UPDATE_SYSTEM_CONFIG")) return;
        const { serverUrl, clientVersion, platform, os } = req.body || {};
        const saved = store.setSystemConfig({
          serverUrl,
          clientVersion,
          platform,
          os,
        });
        updateRuntimeConfig(saved);
        logger.warn("更新系统配置", {
          admin: req.currentUser?.username || "",
          serverUrl: saved?.serverUrl || "",
          clientVersion: saved?.clientVersion || "",
          platform: saved?.platform || "",
          os: saved?.os || "",
          confirmation: "UPDATE_SYSTEM_CONFIG",
        });
        res.json({
          ok: true,
          data: {
            saved,
            current: getRuntimeConfig(),
          },
        });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    },
  );

  app.post(
    "/api/admin/system-config/reset",
    requireAdminToken,
    requireAdminRole,
    (req, res) => {
      try {
        if (!requireDangerConfirmation(req, res, "RESET_SYSTEM_CONFIG")) return;
        const saved = getDefaultSystemConfig();
        store.setSystemConfig(saved);
        updateRuntimeConfig(saved);
        logger.warn("重置系统配置", {
          admin: req.currentUser?.username || "",
          confirmation: "RESET_SYSTEM_CONFIG",
        });
        res.json({
          ok: true,
          data: {
            saved,
            current: getRuntimeConfig(),
          },
        });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    },
  );

}

module.exports = { registerAdminSystemRoutes };

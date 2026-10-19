/**
 * 协议下发文本清洗
 *
 * 服务端返回的名称（员工昵称、商品名等）可能带控制字符，直接进日志或界面会破坏排版。
 * 统一在这里处理，避免各处在正则里手写控制字符范围（也避免为此关闭 no-control-regex）。
 */

/**
 * 去掉控制字符（保留普通空白），可选截断长度
 * @param {*} value - 原始文本
 * @param {number} [maxLength] - 最大长度，0 表示不截断
 * @returns {string}
 */
function sanitizeProtocolText(value, maxLength = 0) {
  // 按码点过滤，避免正则里的控制字符字面量被静态检查误伤。
  const cleaned = Array.from(String(value || ''))
    .filter((char) => {
      const code = char.codePointAt(0);
      return code > 0x1F && code !== 0x7F;
    })
    .join('');
  const limit = Number(maxLength) || 0;
  return limit > 0 ? cleaned.slice(0, limit) : cleaned;
}

module.exports = { sanitizeProtocolText };

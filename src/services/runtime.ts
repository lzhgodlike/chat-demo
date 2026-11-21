/** 构建期注入的运行模式：服务器模式启用登录、同源 API 代理和服务器端历史存储。 */
export const SERVER_MODE = typeof __SERVER_MODE__ === 'undefined' ? false : __SERVER_MODE__

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const db = env.DB;

  // 统一响应格式
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  // --- 密码加密辅助函数 ---
  async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }

  try {
    // 1. 注册接口
    if (action === 'register') {
      const { username, password } = await request.json();
      if (!username || !password) return json({ error: '用户名和密码不能为空' }, 400);
      
      const count = await db.prepare("SELECT COUNT(*) as c FROM users").first();
      if (count.c >= 100) return json({ error: '注册名额已满(100人)' }, 403);

      const salt = crypto.randomUUID();
      const hash = await hashPassword(password, salt);
      const now = Date.now();
      
      try {
        await db.prepare("INSERT INTO users (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, 'user', ?)")
                .bind(username, hash, salt, now).run();
        return json({ success: true });
      } catch (e) {
        return json({ error: '用户名已存在' }, 400);
      }
    }

    // 2. 登录接口
    if (action === 'login') {
      const { username, password } = await request.json();
      const user = await db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
      if (!user) return json({ error: '用户名或密码错误' }, 401);
      
      const hash = await hashPassword(password, user.salt);
      if (hash !== user.password_hash) return json({ error: '用户名或密码错误' }, 401);

      // 生成会话
      const sessionId = crypto.randomUUID();
      const now = Date.now();
      await db.prepare("INSERT INTO sessions (session_id, user_id, role, last_seen) VALUES (?, ?, ?, ?)")
              .bind(sessionId, user.id, user.role, now).run();

      return new Response(JSON.stringify({ success: true, username: user.username, sessionId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax` }
      });
    }

    // 下面需要登录才能访问
    const cookie = request.headers.get('Cookie') || '';
    const sessionId = cookie.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return json({ error: '未登录' }, 401);
    
    const session = await db.prepare("SELECT * FROM sessions WHERE session_id = ?").bind(sessionId).first();
    if (!session) return json({ error: '会话已过期，请重新登录' }, 401);

    // 3. 心跳 (更新在线状态)
    if (action === 'heartbeat') {
      await db.prepare("UPDATE sessions SET last_seen = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
      // 清理超过90秒没心跳的会话
      await db.prepare("DELETE FROM sessions WHERE last_seen < ?").bind(Date.now() - 90000).run();
      return json({ success: true });
    }

    // 4. 拉取消息
    if (action === 'getMessages') {
      const afterId = parseInt(url.searchParams.get('after') || '0');
      // 只拉取 afterId 之后的，最多50条
      const { results } = await db.prepare("SELECT id, username, text, created_at FROM messages WHERE id > ? ORDER BY id ASC LIMIT 50").bind(afterId).all();
      return json({ messages: results });
    }

    // 5. 发送消息
    if (action === 'sendMessage') {
      const { text } = await request.json();
      if (!text || text.length > 300) return json({ error: '消息不能为空且不能超过300字' }, 400);

      const user = await db.prepare("SELECT username FROM users WHERE id = ?").bind(session.user_id).first();
      const now = Date.now();

      // 插入消息
      await db.prepare("INSERT INTO messages (user_id, username, text, created_at) VALUES (?, ?, ?, ?)")
              .bind(session.user_id, user.username, text, now).run();
      
      // 删除多余消息（只留最新50条）
      await db.prepare("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 50)").run();

      return json({ success: true });
    }

    return json({ error: '未知请求' }, 404);

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
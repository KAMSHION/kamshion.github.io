export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const db = env.DB;

  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }

  try {
    if (action === 'register') {
      const { account, display_name, password } = await request.json();
      const normalizedAccount = typeof account === 'string' ? account.trim() : '';
      const displayName = typeof display_name === 'string' ? display_name.trim() : '';
      if (!normalizedAccount || !displayName || typeof password !== 'string' || !password) return json({ error: '账户名、用户名和密码不能为空' }, 400);
      if (normalizedAccount.length > 30 || displayName.length > 20) return json({ error: '账户名最多30个字符，用户名最多20个字符' }, 400);
      if (!/^[A-Za-z0-9_$]+$/.test(normalizedAccount)) return json({ error: '账户名只能包含大小写英文字母、数字、下划线和美元符号（$）' }, 400);
      const count = await db.prepare("SELECT COUNT(*) as c FROM users").first();
      if (count.c >= 100) return json({ error: '注册名额已满(100人)' }, 403);
      const salt = crypto.randomUUID();
      const hash = await hashPassword(password, salt);
      try {
        await db.prepare("INSERT INTO users (account, display_name, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, 'user', ?)").bind(normalizedAccount, displayName, hash, salt, Date.now()).run();
        return json({ success: true });
      } catch (error) {
        if (error.message?.includes('UNIQUE constraint failed: users.account')) {
          return json({ error: '账户名已存在' }, 400);
        }
        throw error;
      }
    }

    if (action === 'login') {
      const { account, password } = await request.json();
      const normalizedAccount = typeof account === 'string' ? account.trim() : '';
      if (!normalizedAccount || !/^[A-Za-z0-9_$]+$/.test(normalizedAccount) || typeof password !== 'string' || !password) return json({ error: '账户名或密码错误' }, 401);
      const user = await db.prepare("SELECT * FROM users WHERE account = ?").bind(normalizedAccount).first();
      if (!user) return json({ error: '账户名或密码错误' }, 401);
      const hash = await hashPassword(password, user.salt);
      if (hash !== user.password_hash) return json({ error: '账户名或密码错误' }, 401);
      const sessionId = crypto.randomUUID();
      await db.prepare("INSERT INTO sessions (session_id, user_id, role, last_seen) VALUES (?, ?, ?, ?)").bind(sessionId, user.id, user.role, Date.now()).run();
      return new Response(JSON.stringify({ success: true, displayName: user.display_name, userId: user.id, role: user.role, sessionId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax` }
      });
    }

    const cookie = request.headers.get('Cookie') || '';
    const sessionId = cookie.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return json({ error: '未登录' }, 401);
    const session = await db.prepare("SELECT * FROM sessions WHERE session_id = ?").bind(sessionId).first();
    if (!session) return json({ error: '会话已过期，请重新登录' }, 401);

    if (action === 'heartbeat') {
      await db.prepare("UPDATE sessions SET last_seen = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
      await db.prepare("DELETE FROM sessions WHERE last_seen < ?").bind(Date.now() - 90000).run();
      return json({ success: true });
    }

    // 获取所有用户（用于渲染头像）
    if (action === 'getUsers') {
      const onlineSince = Date.now() - 90000;
      const { results } = await db.prepare(`
        SELECT users.id, users.display_name, users.avatar_base64, users.role,
          (SELECT muted_until FROM user_mutes WHERE user_id = users.id) AS muted_until,
          EXISTS(
            SELECT 1 FROM sessions
            WHERE sessions.user_id = users.id AND sessions.last_seen > ?
          ) AS is_online
        FROM users
        ORDER BY CASE users.role
          WHEN 'super_admin' THEN 0
          WHEN 'admin' THEN 1
          ELSE 2
        END, users.display_name COLLATE NOCASE
      `).bind(onlineSince).all();
      const online = await db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM sessions WHERE last_seen > ?").bind(onlineSince).first();
      return json({ users: results, onlineCount: online.count });
    }

    if (action === 'getPresence') {
      const onlineSince = Date.now() - 90000;
      const { results } = await db.prepare(`
        SELECT users.id,
          users.role,
          EXISTS(
            SELECT 1 FROM sessions
            WHERE sessions.user_id = users.id AND sessions.last_seen > ?
          ) AS is_online
        FROM users
      `).bind(onlineSince).all();
      const online = await db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM sessions WHERE last_seen > ?").bind(onlineSince).first();
      return json({ users: results, onlineCount: online.count });
    }

    if (action === 'muteUser') {
      const moderator = await db.prepare("SELECT display_name, role FROM users WHERE id = ?").bind(session.user_id).first();
      if (!moderator || !['super_admin', 'admin'].includes(moderator.role)) return json({ error: '没有禁言权限' }, 403);
      const { user_id, duration_minutes, reason } = await request.json();
      const userId = Number(user_id);
      const durationMinutes = Number(duration_minutes);
      const muteReason = typeof reason === 'string' ? reason.trim() : '';
      if (!Number.isSafeInteger(userId) || userId <= 0) return json({ error: '成员无效' }, 400);
      if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) return json({ error: '禁言时长必须是大于0的整数分钟' }, 400);
      if (!muteReason) return json({ error: '禁言理由不能为空' }, 400);
      if (muteReason.length > 200) return json({ error: '禁言理由不能超过200个字符' }, 400);
      const mutedUntil = Date.now() + durationMinutes * 60_000;
      if (!Number.isSafeInteger(mutedUntil)) return json({ error: '禁言时长过长' }, 400);
      const target = await db.prepare("SELECT id, display_name, role FROM users WHERE id = ?").bind(userId).first();
      if (!target) return json({ error: '成员不存在' }, 404);
      if (target.role === 'super_admin' || (moderator.role === 'admin' && target.role !== 'user')) {
        return json({ error: moderator.role === 'admin' ? '管理只能禁言普通用户' : '不能禁言超管' }, 403);
      }
      const notificationText = JSON.stringify({
        type: 'moderation',
        action: 'mute',
        targetName: target.display_name,
        actorName: moderator.display_name,
        actorRole: moderator.role,
        durationMinutes,
        reason: muteReason
      });
      await db.batch([
        db.prepare(`
          INSERT INTO user_mutes (user_id, muted_until, muted_by) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET muted_until = excluded.muted_until, muted_by = excluded.muted_by
        `).bind(userId, mutedUntil, session.user_id),
        db.prepare("INSERT INTO messages (user_id, display_name, text, created_at) VALUES (0, '[通知]', ?, ?)").bind(notificationText, Date.now()),
        db.prepare("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 50)")
      ]);
      return json({ success: true, userId, displayName: target.display_name, mutedUntil });
    }

    if (action === 'unmuteUser') {
      const moderator = await db.prepare("SELECT display_name, role FROM users WHERE id = ?").bind(session.user_id).first();
      if (!moderator || !['super_admin', 'admin'].includes(moderator.role)) return json({ error: '没有解除禁言权限' }, 403);
      const { user_id } = await request.json();
      const userId = Number(user_id);
      if (!Number.isSafeInteger(userId) || userId <= 0) return json({ error: '成员无效' }, 400);
      const target = await db.prepare("SELECT id, display_name, role FROM users WHERE id = ?").bind(userId).first();
      if (!target) return json({ error: '成员不存在' }, 404);
      if (target.role === 'super_admin' || (moderator.role === 'admin' && target.role !== 'user')) {
        return json({ error: moderator.role === 'admin' ? '管理只能解除普通用户的禁言' : '不能解除超管的禁言' }, 403);
      }
      const mute = await db.prepare("SELECT muted_until FROM user_mutes WHERE user_id = ?").bind(userId).first();
      if (!mute || mute.muted_until <= Date.now()) return json({ error: '该成员当前未被禁言' }, 400);
      const notificationText = JSON.stringify({
        type: 'moderation',
        action: 'unmute',
        targetName: target.display_name,
        actorName: moderator.display_name,
        actorRole: moderator.role
      });
      await db.batch([
        db.prepare("DELETE FROM user_mutes WHERE user_id = ?").bind(userId),
        db.prepare("INSERT INTO messages (user_id, display_name, text, created_at) VALUES (0, '[通知]', ?, ?)").bind(notificationText, Date.now()),
        db.prepare("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 50)")
      ]);
      return json({ success: true, userId, displayName: target.display_name });
    }

    if (action === 'changeDisplayName') {
      const { display_name } = await request.json();
      const displayName = typeof display_name === 'string' ? display_name.trim() : '';
      if (!displayName) return json({ error: '用户名不能为空' }, 400);
      if (displayName.length > 20) return json({ error: '用户名不能超过20个字符' }, 400);
      await db.batch([
        db.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(displayName, session.user_id),
        db.prepare("UPDATE messages SET display_name = ? WHERE user_id = ?").bind(displayName, session.user_id)
      ]);
      return json({ success: true, displayName });
    }

    // 更新头像
    if (action === 'updateAvatar') {
      const { avatar_base64 } = await request.json();
      if (!avatar_base64 || avatar_base64.length > 140000) return json({ error: '头像必须压缩到100KB以内' }, 400);
      await db.prepare("UPDATE users SET avatar_base64 = ? WHERE id = ?").bind(avatar_base64, session.user_id).run();
      return json({ success: true });
    }

    if (action === 'getMessages') {
      const afterId = parseInt(url.searchParams.get('after') || '0');
      const { results } = await db.prepare(`
        SELECT messages.id, messages.user_id, messages.display_name, messages.text, messages.created_at, users.role
        FROM messages
        LEFT JOIN users ON users.id = messages.user_id
        WHERE messages.id > ?
        ORDER BY messages.id ASC
        LIMIT 50
      `).bind(afterId).all();
      return json({ messages: results });
    }

    if (action === 'sendMessage') {
      const { text } = await request.json();
      if (!text || text.length > 300) return json({ error: '消息不能为空且不能超过300字' }, 400);
      const mute = await db.prepare("SELECT muted_until FROM user_mutes WHERE user_id = ?").bind(session.user_id).first();
      if (mute && mute.muted_until > Date.now()) {
        return json({ error: `你已被禁言，${new Date(mute.muted_until).toLocaleString('zh-CN')} 后可以发言` }, 403);
      }
      if (mute) await db.prepare("DELETE FROM user_mutes WHERE user_id = ?").bind(session.user_id).run();
      const user = await db.prepare("SELECT display_name FROM users WHERE id = ?").bind(session.user_id).first();
      if (!user) return json({ error: '用户不存在' }, 404);
      await db.prepare("INSERT INTO messages (user_id, display_name, text, created_at) VALUES (?, ?, ?, ?)").bind(session.user_id, user.display_name, text, Date.now()).run();
      await db.prepare("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 50)").run();
      return json({ success: true });
    }

    return json({ error: '未知请求' }, 404);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
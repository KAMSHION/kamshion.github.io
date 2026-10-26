let lastMsgId = 0;
let pollingTimer = null;
let messagesFetchInProgress = false;
let messagesFetchQueued = false;
let isSendingMessage = false;
let myUserId = 0;
let myRole = 'user';
let userRoles = new Map();
let muteTarget = null;
let userAvatars = {}; // 存放所有用户的头像字典 {id: base64}

async function api(action, method = 'GET', body = null) {
  const options = { method, headers: {} };
  if (body) {
    options.body = JSON.stringify(body);
    options.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api/chat?action=${action}`, options);
  return await res.json();
}

function showAuthMessage(message, isSuccess = false) {
  const msg = document.getElementById('auth-msg');
  msg.textContent = message;
  msg.classList.toggle('success', isSuccess);
}

function isValidAccount(account) {
  return /^[A-Za-z0-9_$]+$/.test(account);
}

async function register() {
  const account = document.getElementById('register-account').value.trim();
  const displayName = document.getElementById('display-name').value.trim();
  const password = document.getElementById('register-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;
  const message = document.getElementById('register-msg');
  message.classList.remove('success');

  if (!account || !displayName || !password || !confirmPassword) {
    message.textContent = '请完整填写所有信息';
    return;
  }
  if (!isValidAccount(account)) {
    message.textContent = '账户名只能包含大小写英文字母、数字、下划线和美元符号（$）';
    return;
  }
  if (password !== confirmPassword) {
    message.textContent = '两次输入的密码不一致';
    return;
  }

  try {
    const res = await api('register', 'POST', { account, display_name: displayName, password });
    if (res.error) {
      message.textContent = res.error;
      return;
    }
    document.getElementById('auth-form').reset();
    document.getElementById('register-form').reset();
    showLoginPage('注册成功，请使用账户名登录。', true);
    document.getElementById('account').value = account;
  } catch (error) {
    message.textContent = '暂时无法连接服务器，请稍后重试。';
    console.error(error);
  }
}

async function login() {
  const account = document.getElementById('account').value.trim();
  const p = document.getElementById('password').value;
  if (!account || !p) return showAuthMessage('请填写账户名和密码');
  if (!isValidAccount(account)) {
    showAuthMessage('账户名只能包含大小写英文字母、数字、下划线和美元符号（$）');
    return;
  }
  try {
    const res = await api('login', 'POST', { account, password: p });
    if (res.error) {
      showAuthMessage(res.error);
    } else {
      myUserId = res.userId;
      myRole = ['super_admin', 'admin'].includes(res.role) ? res.role : 'user';
      userRoles.set(String(myUserId), myRole);
      document.getElementById('current-user').textContent = res.displayName;
      document.getElementById('auth-panel').style.display = 'none';
      document.getElementById('register-panel').hidden = true;
      document.getElementById('chat-panel').style.display = 'flex';
      startChat();
    }
  } catch (error) {
    showAuthMessage('暂时无法连接服务器，请稍后重试。');
    console.error(error);
  }
}

function showRegisterPage() {
  document.getElementById('auth-panel').style.display = 'none';
  document.getElementById('register-panel').hidden = false;
  document.getElementById('register-msg').textContent = '';
  document.getElementById('register-account').focus();
}

function showLoginPage(message = '', isSuccess = false) {
  document.getElementById('register-panel').hidden = true;
  document.getElementById('auth-panel').style.display = '';
  showAuthMessage(message, isSuccess);
  document.getElementById('account').focus();
}

function roleLabel(role) {
  if (role === 'super_admin') return '超管';
  if (role === 'admin') return '管理';
  return 'Lv.1';
}

function createRoleBadge(role) {
  const badge = document.createElement('span');
  badge.className = `user-badge${role === 'super_admin' ? ' super-admin' : role === 'admin' ? ' administrator' : ''}`;
  badge.textContent = roleLabel(role);
  return badge;
}

function normalizeRole(role) {
  return ['super_admin', 'admin'].includes(role) ? role : 'user';
}

function isKnownRole(role) {
  return role === 'super_admin' || role === 'admin' || role === 'user';
}

function updateRoleBadges(rolesById) {
  document.querySelectorAll('.message[data-user-id] .user-badge').forEach(badge => {
    const role = rolesById.get(badge.closest('.message').dataset.userId);
    if (role) {
      badge.className = createRoleBadge(role).className;
      badge.textContent = roleLabel(role);
    }
  });
  document.querySelectorAll('.member-item').forEach(item => {
    const role = rolesById.get(item.dataset.userId);
    if (!role) return;
    const badge = item.querySelector('.member-identity .user-badge');
    if (badge) {
      badge.className = createRoleBadge(role).className;
      badge.textContent = roleLabel(role);
    }
  });
}

function renderSystemNotification(container, message) {
  let notification;
  try {
    notification = JSON.parse(message.text);
  } catch {
    notification = null;
  }

  const row = document.createElement('div');
  row.className = 'system-notification';
  const marker = document.createElement('span');
  marker.className = 'notification-marker';
  marker.textContent = '[通知]';
  row.appendChild(marker);

  if (!notification || notification.type !== 'moderation' || !['mute', 'unmute'].includes(notification.action)) {
    row.append(document.createTextNode(` ${message.text}`));
    container.appendChild(row);
    return;
  }

  row.append(document.createTextNode(' 用户'));
  const targetName = document.createElement('strong');
  targetName.className = 'notification-user';
  targetName.textContent = notification.targetName;
  row.append(targetName, document.createTextNode(' '));

  if (notification.action === 'mute') {
    row.append(document.createTextNode('已被 '));
  } else {
    row.append(document.createTextNode('的禁言已被 '));
  }
  const actorName = document.createElement('strong');
  actorName.className = 'notification-user notification-actor';
  actorName.textContent = notification.actorName;
  const actor = document.createElement('span');
  actor.className = 'notification-actor-group';
  actor.append(createRoleBadge(notification.actorRole), actorName);
  row.append(actor, document.createTextNode(' '));

  const operation = document.createElement('span');
  operation.className = `notification-operation${notification.action === 'unmute' ? ' released' : ''}`;
  operation.textContent = notification.action === 'mute' ? '禁言' : '解除禁言';
  row.appendChild(operation);

  if (notification.action === 'mute') {
    const duration = document.createElement('strong');
    duration.className = 'notification-duration';
    duration.textContent = ` ${notification.durationMinutes}min`;
    row.append(duration, document.createTextNode('，理由：'));
    const reason = document.createElement('span');
    reason.className = 'notification-reason';
    reason.textContent = notification.reason;
    row.appendChild(reason);
  }

  container.appendChild(row);
}

// 登录后启动
async function startChat() {
  await refreshPresence();
  fetchMessages();
  heartbeat();
  setInterval(heartbeat, 60000);
  setInterval(refreshPresence, 15000);
  pollingTimer = setInterval(() => {
    if (document.visibilityState === 'visible') fetchMessages();
  }, 3000);
}

// 心跳包
async function heartbeat() {
  const status = document.getElementById('connection-status');
  const dot = document.querySelector('.status-dot');
  try {
    const res = await api('heartbeat', 'POST');
    if (res.error) throw new Error(res.error);
    status.textContent = '在线';
    dot.classList.remove('offline');
  } catch (error) {
    status.textContent = '连接异常';
    dot.classList.add('offline');
    console.error(error);
  }
}

// 加载用户头像字典
async function loadUsers() {
  const res = await api('getUsers');
  if (res.error) throw new Error(res.error);
  if (res.users) {
    res.users.forEach(user => {
      if (user.avatar_base64) userAvatars[user.id] = user.avatar_base64;
      else delete userAvatars[user.id];
      updateUserAvatar(user.id, user.avatar_base64, user.display_name);
    });
  }
  return res;
}

async function refreshPresence() {
  try {
    const res = await api('getPresence');
    if (res.error) throw new Error(res.error);
    document.getElementById('online-count').textContent = res.onlineCount ?? 0;
    const users = res.users || [];
    const usersById = new Map(users.map(user => [String(user.id), user]));
    const rolesChanged = users.some(user => {
      const userId = String(user.id);
      return isKnownRole(user.role) && userRoles.has(userId) && userRoles.get(userId) !== user.role;
    });
    users.forEach(user => {
      if (isKnownRole(user.role)) userRoles.set(String(user.id), user.role);
    });
    const currentUser = usersById.get(String(myUserId));
    if (currentUser && isKnownRole(currentUser.role)) myRole = currentUser.role;
    updateRoleBadges(userRoles);

    document.querySelectorAll('.member-item').forEach(item => {
      const user = usersById.get(item.dataset.userId);
      const status = item.querySelector('.member-online-state');
      if (!user || !status) return;
      const isOnline = Boolean(user.is_online);
      status.classList.toggle('offline', !isOnline);
      status.lastChild.textContent = isOnline ? '在线' : '离线';
    });
    if (rolesChanged && document.getElementById('members-dialog').open) showMembers();
  } catch (error) {
    console.error('刷新在线状态失败：', error);
  }
}

function updateUserAvatar(userId, avatarBase64, displayName) {
  const selector = `[data-user-id="${userId}"]`;
  document.querySelectorAll(`.message${selector} .avatar, .member-item${selector} .member-avatar`).forEach(avatar => {
    if (avatarBase64) {
      let image = avatar.querySelector('img');
      if (!image) {
        image = document.createElement('img');
        image.alt = '';
        avatar.replaceChildren(image);
      }
      if (image.src !== avatarBase64) image.src = avatarBase64;
    } else if (avatar.querySelector('img') || avatar.textContent !== displayName.charAt(0).toUpperCase()) {
      avatar.textContent = displayName.charAt(0).toUpperCase();
    }
  });
}

async function showMembers() {
  const dialog = document.getElementById('members-dialog');
  const list = document.getElementById('members-list');
  const count = document.getElementById('members-count');
  list.replaceChildren();
  count.textContent = '正在加载...';
  if (!dialog.open) dialog.showModal();

  try {
    const res = await loadUsers();
    if (res.error) throw new Error(res.error);

    const currentUser = res.users?.find(user => Number(user.id) === Number(myUserId));
    if (currentUser && isKnownRole(currentUser.role)) myRole = currentUser.role;
    (res.users || []).forEach(user => {
      if (isKnownRole(user.role)) userRoles.set(String(user.id), user.role);
    });
    updateRoleBadges(userRoles);

    const roleOrder = { super_admin: 0, admin: 1 };
    const users = (res.users || []).sort((first, second) =>
      (roleOrder[first.role] ?? 2) - (roleOrder[second.role] ?? 2) ||
      first.display_name.localeCompare(second.display_name, 'zh-CN')
    );
    count.textContent = `共 ${users.length} 位成员`;
    if (users.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'members-message';
      empty.textContent = '暂无成员';
      list.appendChild(empty);
      return;
    }

    users.forEach(user => {
      const item = document.createElement('div');
      item.className = 'member-item';
      item.dataset.userId = user.id;

      const avatar = document.createElement('div');
      avatar.className = 'member-avatar';
      if (user.avatar_base64) {
        const image = document.createElement('img');
        image.src = user.avatar_base64;
        image.alt = '';
        avatar.appendChild(image);
      } else {
        avatar.textContent = user.display_name.charAt(0).toUpperCase();
      }

      const displayName = document.createElement('span');
      displayName.className = 'member-name';
      displayName.textContent = user.display_name;

      const identity = document.createElement('div');
      identity.className = 'member-identity';
      const badge = document.createElement('span');
      badge.className = `user-badge${user.role === 'super_admin' ? ' super-admin' : user.role === 'admin' ? ' administrator' : ''}`;
      badge.textContent = roleLabel(user.role);
      identity.append(displayName, badge);

      const onlineState = document.createElement('span');
      onlineState.className = `member-online-state${user.is_online ? '' : ' offline'}`;
      const stateDot = document.createElement('span');
      stateDot.className = 'member-online-dot';
      onlineState.append(stateDot, document.createTextNode(user.is_online ? '在线' : '离线'));

      const profile = document.createElement('div');
      profile.className = 'member-profile';
      profile.append(identity, onlineState);
      item.append(avatar, profile);

      if (user.muted_until > Date.now()) {
        const muteState = document.createElement('span');
        muteState.className = 'member-mute-state';
        muteState.textContent = `禁言至 ${new Date(user.muted_until).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        item.appendChild(muteState);
      }

      const canModerateTarget = myRole === 'super_admin'
        ? user.role !== 'super_admin'
        : myRole === 'admin' && user.role === 'user';
      if (canModerateTarget) {
        const muteButton = document.createElement('button');
        muteButton.className = 'member-mute-btn';
        muteButton.type = 'button';
        const isMuted = user.muted_until > Date.now();
        muteButton.textContent = isMuted ? '解除' : '禁言';
        muteButton.classList.toggle('unmute', isMuted);
        muteButton.addEventListener('click', () => {
          if (user.muted_until > Date.now()) openUnmuteDialog(user);
          else openMuteDialog(user);
        });
        item.appendChild(muteButton);
      }

      list.appendChild(item);
    });
  } catch (error) {
    count.textContent = '成员加载失败';
    const message = document.createElement('p');
    message.className = 'members-message error';
    message.textContent = error.message || '请检查网络后重试。';
    list.appendChild(message);
    console.error('加载成员失败：', error);
  }
}

// 拉取消息
async function fetchMessages() {
  if (messagesFetchInProgress) {
    messagesFetchQueued = true;
    return;
  }

  messagesFetchInProgress = true;
  try {
    do {
      messagesFetchQueued = false;
      const res = await api(`getMessages&after=${lastMsgId}`);
      if (res.error) {
        console.error(res.error);
        break;
      }

      if (res.messages && res.messages.length > 0) {
        const msgContainer = document.getElementById('messages');

        res.messages.forEach(msg => {
          if (msg.id <= lastMsgId) return;
          lastMsgId = msg.id;
          const isMine = Number(msg.user_id) === Number(myUserId);

          const div = document.createElement('div');
          div.className = 'message' + (isMine ? ' mine' : '');
          div.dataset.messageId = msg.id;
          div.dataset.userId = msg.user_id;

          const isSystemNotification = Number(msg.user_id) === 0
            || msg.display_name === '[通知]'
            || (() => {
              try {
                return JSON.parse(msg.text).type === 'moderation';
              } catch {
                return false;
              }
            })();
          if (isSystemNotification) {
            renderSystemNotification(msgContainer, msg);
            document.getElementById('empty-state').hidden = true;
            return;
          }

          const avatarDiv = document.createElement('div');
          avatarDiv.className = 'avatar';
          if (userAvatars[msg.user_id]) {
            const avatarImage = document.createElement('img');
            avatarImage.src = userAvatars[msg.user_id];
            avatarImage.alt = '';
            avatarDiv.appendChild(avatarImage);
          } else {
            avatarDiv.innerText = msg.display_name.charAt(0).toUpperCase();
          }

          const bodyDiv = document.createElement('div');
          bodyDiv.className = 'message-body';

          const bubbleDiv = document.createElement('div');
          bubbleDiv.className = 'bubble';

          const senderDiv = document.createElement('div');
          senderDiv.className = 'sender';

          const userId = String(msg.user_id);
          const messageRole = isKnownRole(msg.role) ? msg.role : userRoles.get(userId);
          if (isKnownRole(msg.role)) userRoles.set(userId, msg.role);
          const badgeDiv = createRoleBadge(messageRole);

          const usernameSpan = document.createElement('span');
          usernameSpan.className = 'sender-name';
          usernameSpan.textContent = msg.display_name;
          senderDiv.append(badgeDiv, usernameSpan);

          const contentDiv = document.createElement('div');
          contentDiv.className = 'content';
          contentDiv.textContent = msg.text;

          const timeDiv = document.createElement('div');
          timeDiv.className = 'message-time';
          timeDiv.textContent = new Date(Number(msg.created_at)).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
          });

          bubbleDiv.appendChild(contentDiv);
          bodyDiv.appendChild(senderDiv);
          bodyDiv.appendChild(bubbleDiv);
          bodyDiv.appendChild(timeDiv);
          div.appendChild(avatarDiv);
          div.appendChild(bodyDiv);

          msgContainer.appendChild(div);
        });
        document.getElementById('empty-state').hidden = true;
        msgContainer.scrollTop = msgContainer.scrollHeight;
      }
    } while (messagesFetchQueued);
  } catch (error) {
    console.error('获取消息失败：', error);
  } finally {
    messagesFetchInProgress = false;
  }
}

async function sendMessage() {
  if (isSendingMessage) return;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  isSendingMessage = true;
  updateComposer();
  try {
    const res = await api('sendMessage', 'POST', { text });
    if (res.error) {
      alert(res.error);
      return;
    }
    input.value = '';
    updateComposer();
    await fetchMessages();
  } catch (error) {
    alert('发送失败，请检查网络后重试。');
    console.error(error);
  } finally {
    isSendingMessage = false;
    updateComposer();
  }
}

async function changeDisplayName(event) {
  event.preventDefault();
  const input = document.getElementById('new-display-name');
  const message = document.getElementById('username-msg');
  const saveButton = document.getElementById('username-save-btn');
  const displayName = input.value.trim();
  message.textContent = '';
  message.classList.remove('success');

  if (!displayName) {
    message.textContent = '用户名不能为空';
    return;
  }

  saveButton.disabled = true;
  try {
    const res = await api('changeDisplayName', 'POST', { display_name: displayName });
    if (res.error) {
      message.textContent = res.error;
      return;
    }

    document.getElementById('current-user').textContent = res.displayName;
    document.querySelectorAll('.message').forEach(row => {
      if (Number(row.dataset.userId) !== Number(myUserId)) return;
      const name = row.querySelector('.sender-name');
      const badge = row.querySelector('.user-badge');
      const avatar = row.querySelector('.avatar');
      if (name) name.textContent = res.displayName;
      if (badge) {
        badge.textContent = roleLabel(myRole);
        badge.classList.toggle('super-admin', myRole === 'super_admin');
        badge.classList.toggle('administrator', myRole === 'admin');
      }
      if (avatar && !avatar.querySelector('img')) {
        avatar.textContent = res.displayName.charAt(0).toUpperCase();
      }
    });

    const member = document.querySelector(`.member-item[data-user-id="${myUserId}"] .member-name`);
    if (member) member.textContent = res.displayName;
    message.textContent = '用户名已更新';
    message.classList.add('success');
    window.setTimeout(() => document.getElementById('username-dialog').close(), 500);
  } catch (error) {
    message.textContent = '更新失败，请检查网络后重试。';
    console.error('更改用户名失败：', error);
  } finally {
    saveButton.disabled = false;
  }
}

function openMuteDialog(user) {
  muteTarget = user;
  document.getElementById('mute-title').textContent = `将用户${user.display_name}禁言`;
  document.getElementById('mute-duration-label').textContent = `禁言用户${user.display_name}，时长（min）`;
  document.getElementById('mute-duration').value = '';
  document.getElementById('mute-reason').value = '';
  document.getElementById('mute-msg').textContent = '';
  document.getElementById('mute-dialog').showModal();
  document.getElementById('mute-duration').focus();
}

async function muteMember(event) {
  event.preventDefault();
  if (!muteTarget) return;
  const durationInput = document.getElementById('mute-duration');
  const message = document.getElementById('mute-msg');
  const confirmButton = document.getElementById('mute-confirm-btn');
  const durationMinutes = Number(durationInput.value);
  const reason = document.getElementById('mute-reason').value.trim();
  message.textContent = '';
  message.classList.remove('success');

  if (!Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) {
    message.textContent = '请输入大于0的整数分钟';
    return;
  }
  if (!reason) {
    message.textContent = '请填写禁言理由';
    return;
  }

  confirmButton.disabled = true;
  try {
    const res = await api('muteUser', 'POST', {
      user_id: muteTarget.id,
      duration_minutes: durationMinutes,
      reason
    });
    if (res.error) {
      message.textContent = res.error;
      return;
    }

    message.textContent = `已将${res.displayName}禁言 ${durationMinutes} 分钟`;
    message.classList.add('success');
    const member = document.querySelector(`.member-item[data-user-id="${res.userId}"]`);
    if (member) {
      let state = member.querySelector('.member-mute-state');
      if (!state) {
        state = document.createElement('span');
        state.className = 'member-mute-state';
        member.insertBefore(state, member.querySelector('.member-mute-btn'));
      }
      state.textContent = `禁言至 ${new Date(res.mutedUntil).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      const button = member.querySelector('.member-mute-btn');
      if (button) {
        button.textContent = '解除';
        button.classList.add('unmute');
      }
    }
    await fetchMessages();
    window.setTimeout(() => document.getElementById('mute-dialog').close(), 700);
  } catch (error) {
    message.textContent = '禁言失败，请检查网络后重试。';
    console.error('禁言成员失败：', error);
  } finally {
    confirmButton.disabled = false;
  }
}

function openUnmuteDialog(user) {
  muteTarget = user;
  document.getElementById('unmute-title').textContent = `解除用户${user.display_name}的禁言`;
  document.getElementById('unmute-description').textContent = `确认解除${user.display_name}的禁言吗？`;
  document.getElementById('unmute-msg').textContent = '';
  document.getElementById('unmute-dialog').showModal();
}

async function unmuteMember() {
  if (!muteTarget) return;
  const message = document.getElementById('unmute-msg');
  const confirmButton = document.getElementById('unmute-confirm-btn');
  confirmButton.disabled = true;
  message.textContent = '';

  try {
    const res = await api('unmuteUser', 'POST', { user_id: muteTarget.id });
    if (res.error) {
      message.textContent = res.error;
      return;
    }

    message.textContent = `${res.displayName}已解除禁言`;
    message.classList.add('success');
    const member = document.querySelector(`.member-item[data-user-id="${res.userId}"]`);
    if (member) {
      member.querySelector('.member-mute-state')?.remove();
      const button = member.querySelector('.member-mute-btn');
      if (button) {
        button.textContent = '禁言';
        button.classList.remove('unmute');
      }
    }
    await fetchMessages();
    window.setTimeout(() => document.getElementById('unmute-dialog').close(), 700);
  } catch (error) {
    message.textContent = '解除禁言失败，请检查网络后重试。';
    console.error('解除禁言失败：', error);
  } finally {
    confirmButton.disabled = false;
  }
}

function setTheme(theme) {
  const isNight = theme === 'night';
  document.documentElement.dataset.theme = isNight ? 'night' : 'day';
  const toggle = document.getElementById('theme-toggle');
  toggle.textContent = isNight ? '切换到白昼' : '切换到极夜';
  toggle.setAttribute('aria-pressed', String(isNight));
  document.querySelector('meta[name="theme-color"]').content = isNight ? '#111827' : '#f4f7fb';
  try {
    localStorage.setItem('chat-theme', isNight ? 'night' : 'day');
  } catch (error) {
    console.error('无法保存主题偏好：', error);
  }
}

// === 头像压缩与上传逻辑 ===
async function uploadAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  
  try {
    const base64 = await compressImage(file, 1000, 1000);
    const res = await api('updateAvatar', 'POST', { avatar_base64: base64 });
    if (res.error) {
      alert('上传失败：' + res.error);
    } else {
      alert('头像更新成功！');
      userAvatars[myUserId] = base64;
      updateUserAvatar(myUserId, base64, document.getElementById('current-user').textContent);
    }
  } catch (e) {
    alert(e.message || '图片处理失败');
  }
  input.value = ''; // 清空选中
}

function compressImage(file, maxWidth, maxHeight) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = e => {
      const img = new Image();
      img.src = e.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('无法处理这张图片'));
          return;
        }

        const initialScale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
        let scale = initialScale;
        let quality = 0.9;
        let attempts = 0;

        const encode = () => {
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob => {
            if (!blob) {
              reject(new Error('图片压缩失败'));
              return;
            }
            if (blob.size <= 100 * 1024) {
              const outputReader = new FileReader();
              outputReader.onload = () => resolve(outputReader.result);
              outputReader.onerror = () => reject(new Error('压缩后的图片读取失败'));
              outputReader.readAsDataURL(blob);
              return;
            }
            attempts += 1;
            if (attempts >= 12) {
              reject(new Error('图片无法压缩到100KB以内，请选择较小的图片'));
              return;
            }
            if (quality > 0.65) quality -= 0.1;
            else {
              quality = 0.85;
              scale *= 0.8;
            }
            encode();
          }, 'image/jpeg', quality);
        };

        encode();
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

function logout() {
  document.cookie = 'session=; Max-Age=0; path=/';
  location.reload();
}

// === 新增：监听键盘 Enter 发送逻辑 ===
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('msg-input');
  const authForm = document.getElementById('auth-form');
  const registerForm = document.getElementById('register-form');
  const messageForm = document.getElementById('message-form');
  const membersDialog = document.getElementById('members-dialog');
  const usernameDialog = document.getElementById('username-dialog');
  const muteDialog = document.getElementById('mute-dialog');
  const unmuteDialog = document.getElementById('unmute-dialog');

  let savedTheme = 'day';
  try {
    savedTheme = localStorage.getItem('chat-theme') === 'night' ? 'night' : 'day';
  } catch (error) {
    console.error('无法读取主题偏好：', error);
  }
  setTheme(savedTheme);
  document.getElementById('theme-toggle').addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'night' ? 'day' : 'night');
  });

  authForm.addEventListener('submit', event => {
    event.preventDefault();
    showAuthMessage('');
    login();
  });

  document.getElementById('show-register-btn').addEventListener('click', showRegisterPage);
  document.getElementById('back-to-login-btn').addEventListener('click', () => showLoginPage());

  registerForm.addEventListener('submit', event => {
    event.preventDefault();
    register();
  });

  messageForm.addEventListener('submit', event => {
    event.preventDefault();
    sendMessage();
  });

  document.getElementById('members-btn').addEventListener('click', showMembers);
  document.getElementById('members-close').addEventListener('click', () => membersDialog.close());
  document.getElementById('change-name-btn').addEventListener('click', () => {
    document.getElementById('new-display-name').value = document.getElementById('current-user').textContent;
    document.getElementById('username-msg').textContent = '';
    document.getElementById('username-msg').classList.remove('success');
    usernameDialog.showModal();
    document.getElementById('new-display-name').focus();
  });
  document.getElementById('username-dialog-close').addEventListener('click', () => usernameDialog.close());
  document.getElementById('username-cancel-btn').addEventListener('click', () => usernameDialog.close());
  document.getElementById('username-form').addEventListener('submit', changeDisplayName);
  document.getElementById('mute-dialog-close').addEventListener('click', () => muteDialog.close());
  document.getElementById('mute-cancel-btn').addEventListener('click', () => muteDialog.close());
  document.getElementById('mute-form').addEventListener('submit', muteMember);
  document.getElementById('unmute-dialog-close').addEventListener('click', () => unmuteDialog.close());
  document.getElementById('unmute-cancel-btn').addEventListener('click', () => unmuteDialog.close());
  document.getElementById('unmute-confirm-btn').addEventListener('click', unmuteMember);

  if (input) {
    input.addEventListener('input', updateComposer);
    input.addEventListener('keydown', (e) => {
      // 如果按下的是 Enter 键
      if (e.key === 'Enter') {
        // 如果没有按 Shift，则发送消息并阻止默认换行
        if (!e.shiftKey) {
          e.preventDefault(); // 阻止默认的回车换行行为
          if (!e.repeat) sendMessage();
        }
        // 如果按了 Shift + Enter，就什么都不做，让它默认换行
      }
    });
  }

  updateComposer();
});

function updateComposer() {
  const input = document.getElementById('msg-input');
  const counter = document.getElementById('char-count');
  const sendButton = document.getElementById('send-btn');
  if (!input || !counter || !sendButton) return;
  counter.textContent = `${input.value.length} / 300`;
  sendButton.disabled = isSendingMessage || !input.value.trim();
}
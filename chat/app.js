let lastMsgId = 0;
let pollingTimer = null;
let myUsername = '';

// 辅助请求函数
async function api(action, method = 'GET', body = null) {
  const options = { method, headers: {} };
  if (body) {
    options.body = JSON.stringify(body);
    options.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api/chat?action=${action}`, options);
  return await res.json();
}

// 注册
async function register() {
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;
  if (!u || !p) return alert('请填写用户名和密码');
  
  const res = await api('register', 'POST', { username: u, password: p });
  if (res.error) {
    document.getElementById('auth-msg').innerText = res.error;
  } else {
    alert('注册成功，请登录');
  }
}

// 登录
async function login() {
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;
  if (!u || !p) return alert('请填写用户名和密码');

  const res = await api('login', 'POST', { username: u, password: p });
  if (res.error) {
    document.getElementById('auth-msg').innerText = res.error;
  } else {
    myUsername = res.username;
    document.getElementById('auth-panel').style.display = 'none';
    document.getElementById('chat-panel').style.display = 'flex';
    startChat();
  }
}

// 启动聊天 (开始轮询和心跳)
function startChat() {
  fetchMessages();
  setInterval(heartbeat, 60000); // 60秒心跳
  
  // 3秒轮询
  pollingTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      fetchMessages();
    }
  }, 3000);
}

// 心跳包
async function heartbeat() {
  await api('heartbeat', 'POST');
}

// 拉取消息
async function fetchMessages() {
  const res = await api(`getMessages&after=${lastMsgId}`);
  if (res.error) return console.error(res.error);
  
  if (res.messages && res.messages.length > 0) {
    const msgContainer = document.getElementById('messages');
    res.messages.forEach(msg => {
      if (msg.id > lastMsgId) lastMsgId = msg.id;
      
      const div = document.createElement('div');
      div.className = 'message' + (msg.username === myUsername ? ' mine' : '');
      
      const sender = document.createElement('div');
      sender.className = 'sender';
      sender.innerText = msg.username;
      
      const content = document.createElement('div');
      // 安全渲染：纯文本显示防 XSS
      content.innerText = msg.text; 
      
      div.appendChild(sender);
      div.appendChild(content);
      msgContainer.appendChild(div);
    });
    
    // 滚动到底部
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }
}

// 发送消息
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  
  input.value = '';
  const res = await api('sendMessage', 'POST', { text });
  if (res.error) {
    alert(res.error);
  } else {
    fetchMessages(); // 发完立刻拉取一次
  }
}

// 退出登录
function logout() {
  document.cookie = 'session=; Max-Age=0; path=/';
  location.reload();
}
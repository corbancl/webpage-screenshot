let screenshotType = 'visible';

function selectOption(element) {
  document.querySelectorAll('.option-btn').forEach(btn => btn.classList.remove('active'));
  element.classList.add('active');
  screenshotType = element.dataset.type;
}

// 初始化事件监听
document.addEventListener('DOMContentLoaded', () => {
  // 绑定选项按钮点击事件
  document.querySelectorAll('.option-btn').forEach(btn => {
    btn.addEventListener('click', () => selectOption(btn));
  });

  // 绑定截图按钮点击事件
  document.getElementById('captureBtn').addEventListener('click', captureScreenshot);
});

function showStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = 'status show ' + (isError ? 'error' : 'success');
  setTimeout(() => {
    status.className = 'status';
  }, 3000);
}

function setLoading(isLoading) {
  const btn = document.getElementById('captureBtn');
  btn.disabled = isLoading;
  btn.textContent = isLoading ? '⏳ 截图中...' : '📸 开始截图';
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function captureScreenshot() {
  const tab = await getCurrentTab();

  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    showStatus('无法截取 Chrome 内部页面', true);
    return;
  }

  setLoading(true);

  try {
    if (screenshotType === 'visible') {
      await captureVisible(tab);
    } else if (screenshotType === 'full') {
      await captureFullPage(tab);
    } else if (screenshotType === 'selection') {
      await captureSelection(tab);
    }
  } catch (error) {
    console.error('Screenshot error:', error);
    showStatus('截图失败: ' + error.message, true);
    setLoading(false);
  }
}

async function captureVisible(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  await downloadImage(dataUrl, generateFilename(tab.title));
  showStatus('截图成功！');
  setLoading(false);
}

async function captureFullPage(tab) {
  // 注入脚本获取页面尺寸并滚动截图
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      return {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      };
    }
  });

  const { width, height, viewportWidth, viewportHeight, devicePixelRatio } = results[0].result;

  // 注入滚动和截图脚本
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      window.scrollTo(0, 0);
      window.__screenshotData = { images: [], positions: [] };
    }
  });

  const canvas = new OffscreenCanvas(width * devicePixelRatio, height * devicePixelRatio);
  const ctx = canvas.getContext('2d');

  let currentPosition = 0;
  const step = viewportHeight - 100; // 重叠100像素避免拼接缝隙

  while (currentPosition < height) {
    // 滚动到位置
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (pos) => { window.scrollTo(0, pos); },
      args: [currentPosition]
    });

    // 等待页面稳定
    await new Promise(r => setTimeout(r, 150));

    // 截图
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    // 绘制到 canvas
    const img = await createImageBitmap(await fetch(dataUrl).then(r => r.blob()));
    ctx.drawImage(img, 0, currentPosition * devicePixelRatio);

    currentPosition += step;

    // 更新进度
    const progress = Math.min(100, Math.round((currentPosition / height) * 100));
    document.getElementById('captureBtn').textContent = `⏳ 截图中... ${progress}%`;
  }

  // 转换为 blob 并下载
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const url = URL.createObjectURL(blob);

  await downloadImage(url, generateFilename(tab.title));
  showStatus('整页截图成功！');

  // 滚动回顶部
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => { window.scrollTo(0, 0); }
  });

  setLoading(false);
}

async function captureSelection(tab) {
  // 注入选区脚本
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      if (window.__screenshotOverlay) {
        window.__screenshotOverlay.remove();
      }

      const overlay = document.createElement('div');
      overlay.id = '__screenshot_overlay__';
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.3);
        cursor: crosshair;
        z-index: 2147483647;
      `;
      document.body.appendChild(overlay);

      const box = document.createElement('div');
      box.id = '__screenshot_box__';
      box.style.cssText = `
        position: absolute;
        border: 2px dashed #fff;
        background: rgba(102, 126, 234, 0.2);
        display: none;
      `;
      overlay.appendChild(box);

      let startX, startY, isDrawing = false;

      overlay.onmousedown = (e) => {
        isDrawing = true;
        startX = e.clientX;
        startY = e.clientY;
        box.style.display = 'block';
        box.style.left = startX + 'px';
        box.style.top = startY + 'px';
        box.style.width = '0';
        box.style.height = '0';
      };

      overlay.onmousemove = (e) => {
        if (!isDrawing) return;
        const currentX = e.clientX;
        const currentY = e.clientY;
        box.style.left = Math.min(startX, currentX) + 'px';
        box.style.top = Math.min(startY, currentY) + 'px';
        box.style.width = Math.abs(currentX - startX) + 'px';
        box.style.height = Math.abs(currentY - startY) + 'px';
      };

      overlay.onmouseup = (e) => {
        if (!isDrawing) return;
        isDrawing = false;
        const rect = {
          x: parseInt(box.style.left),
          y: parseInt(box.style.top),
          width: parseInt(box.style.width),
          height: parseInt(box.style.height)
        };
        overlay.remove();
        window.__screenshotRect = rect;
      };

      overlay.onkeydown = (e) => {
        if (e.key === 'Escape') {
          overlay.remove();
          window.__screenshotRect = null;
        }
      };

      overlay.tabIndex = 0;
      overlay.focus();

      window.__screenshotOverlay = overlay;
    }
  });

  showStatus('请在页面上框选区域，按 ESC 取消');

  // 等待用户完成选区
  let attempts = 0;
  const checkSelection = async () => {
    attempts++;
    if (attempts > 120) { // 60秒超时
      showStatus('选区超时，已取消', true);
      setLoading(false);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { if (window.__screenshotOverlay) window.__screenshotOverlay.remove(); }
      });
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__screenshotRect
    });

    const rect = results[0].result;

    if (rect && rect.width > 10 && rect.height > 10) {
      // 截取选区
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

      // 裁剪图片
      const img = await createImageBitmap(await fetch(dataUrl).then(r => r.blob()));
      const dpr = window.devicePixelRatio || 1;
      const canvas = new OffscreenCanvas(rect.width * dpr, rect.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr, 0, 0, rect.width * dpr, rect.height * dpr);

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const url = URL.createObjectURL(blob);

      await downloadImage(url, generateFilename(tab.title));
      showStatus('区域截图成功！');
      setLoading(false);
    } else {
      setTimeout(checkSelection, 500);
    }
  };

  setTimeout(checkSelection, 500);
}

function generateFilename(title) {
  const date = new Date();
  const timestamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  const safeTitle = (title || 'screenshot').replace(/[\\/:*?"<>|]/g, '-').substring(0, 30);
  return `${safeTitle}_${timestamp}.png`;
}

async function downloadImage(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

document.addEventListener("DOMContentLoaded", () => {
  // デバッグ用：スマホで最新版が読み込まれたか確認
  console.log("Script version: 1.6 - Full Source Restored & Mobile Playback Fixed");

  let db;
  let currentThreadId = null;
  let mediaRecorder;
  let audioChunks = [];
  let isPlayingAll = false;
  let audioQueue = []; // ソース[1]に基づき保持

  // 録音・解析用変数のグローバル宣言 [1]
  let audioContext;
  let analyser;
  let dataArray;
  let animationId;
  let sourceNode;
  let recordingStream;
  let countdownInterval;

  const recordBtn = document.getElementById("recordBtn");
  const stopBtn = document.getElementById("stopBtn");
  const playAllBtn = document.getElementById("playAllBtn");
  const deleteThreadBtn = document.getElementById("deleteThreadBtn");

  if (playAllBtn) playAllBtn.onclick = playAll;
  if (deleteThreadBtn) deleteThreadBtn.onclick = deleteCurrentThread;

  // --- IndexedDBの初期化 [2][3] ---
  const request = indexedDB.open("voiceAppDB", 2);

  request.onupgradeneeded = e => {
    db = e.target.result;
    if (!db.objectStoreNames.contains("threads")) {
      const threadStore = db.createObjectStore("threads", { keyPath: "id" });
      threadStore.createIndex("title", "title");
      threadStore.createIndex("lastUpdatedAt", "lastUpdatedAt");
    }
    if (!db.objectStoreNames.contains("messages")) {
      const messageStore = db.createObjectStore("messages", { keyPath: "id" });
      messageStore.createIndex("threadId", "threadId");
      messageStore.createIndex("createdAt", "createdAt");
    }
  };

  request.onsuccess = e => {
    db = e.target.result;
    renderThreadsByReplyCount(); // 初期表示
    updateCapacity();
  };

  // --- ユーティリティ・削除系ロジック [3][4][5][6] ---
  function todayString() {
    return new Date().toISOString().split("T");
  }

  function deleteCurrentThread() {
    if (!currentThreadId) return;
    const confirmed = confirm("本当に削除しますか？");
    if (!confirmed) return;

    const tx = db.transaction(["threads", "messages"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const index = msgStore.index("threadId");

    index.openCursor(IDBKeyRange.only(currentThreadId)).onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.objectStore("threads").delete(currentThreadId);
    tx.oncomplete = () => {
      closeThread();
      renderThreads(); // ソース[4]の呼び出しを維持
      updateCapacity();
    };
  }

  function deleteMessage(messageId) {
    const tx = db.transaction(["messages", "threads"], "readwrite");
    const msgStore = tx.objectStore("messages");
    msgStore.delete(messageId);
    tx.oncomplete = () => {
      recalculateThreadUpdatedAt(currentThreadId);
    };
  }

  function recalculateThreadUpdatedAt(threadId) {
    const tx = db.transaction(["messages", "threads"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const threadStore = tx.objectStore("threads");
    const index = msgStore.index("threadId");
    const messages = [];

    index.openCursor(IDBKeyRange.only(threadId)).onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) {
        if (messages.length === 0) {
          threadStore.delete(threadId);
          closeThread();
          return;
        }
        const latest = Math.max(...messages.map(m => m.createdAt));
        const getReq = threadStore.get(threadId);
        getReq.onsuccess = () => {
          const thread = getReq.result;
          if (!thread) return;
          thread.lastUpdatedAt = latest;
          threadStore.put(thread);
        };
        return;
      }
      messages.push(cursor.value);
      cursor.continue();
    };
    tx.oncomplete = () => {
      renderMessages();
      renderThreads();
      updateCapacity();
    };
  }

  // --- スレッド表示・検索ロジック [7][8][9][10][11][12] ---
  function renderThreads() {
    const list = document.getElementById("threadList");
    if (!list) return;
    list.innerHTML = "";
    const tx = db.transaction("threads", "readonly");
    const store = tx.objectStore("threads");
    const index = store.index("lastUpdatedAt");

    index.openCursor(null, "prev").onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) return;
      const thread = cursor.value;
      const card = document.createElement("div");
      card.className = "threadCard";
      countMessages(thread.id, count => {
        const contentDiv = document.createElement("div");
        contentDiv.className = "threadCardContent";
        const titleDiv = document.createElement("div");
        titleDiv.className = "title";
        titleDiv.textContent = thread.title;
        const infoDiv = document.createElement("div");
        infoDiv.className = "threadInfo";
        infoDiv.textContent = `${new Date(thread.lastUpdatedAt).toLocaleString()} - レス ${count} 件`;
        contentDiv.appendChild(titleDiv);
        contentDiv.appendChild(infoDiv);
        card.appendChild(contentDiv);
      });
      card.onclick = () => openThread(thread.id);
      list.appendChild(card);
      cursor.continue();
    };
  }

  const searchInput = document.getElementById("threadSearchInput");
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const query = searchInput.value.trim();
        renderThreadsByReplyCount(query);
      }
    });
  }

  function renderThreadsByReplyCount(filterText = "") {
    const list = document.getElementById("threadList");
    if (!list) return;
    list.innerHTML = "";
    const tx = db.transaction("threads", "readonly");
    const store = tx.objectStore("threads");
    const threadsWithCount = [];
    let remaining = 0;

    store.openCursor().onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) {
        if (remaining === 0) drawThreads();
        return;
      }
      const thread = cursor.value;
      if (filterText && !thread.title.includes(filterText)) {
        cursor.continue();
        return;
      }
      remaining++;
      countMessages(thread.id, count => {
        threadsWithCount.push({ thread, count });
        remaining--;
        if (remaining === 0) drawThreads();
      });
      cursor.continue();
    };

    function drawThreads() {
      threadsWithCount.sort((a, b) => b.count - a.count);
      threadsWithCount.forEach(({ thread, count }) => {
        const card = document.createElement("div");
        card.className = "threadCard";
        const contentDiv = document.createElement("div");
        contentDiv.className = "threadCardContent";
        const titleDiv = document.createElement("div");
        titleDiv.className = "title";
        titleDiv.textContent = thread.title;
        const infoDiv = document.createElement("div");
        infoDiv.className = "threadInfo";
        infoDiv.textContent = `${new Date(thread.lastUpdatedAt).toLocaleString()} - レス ${count} 件`;
        contentDiv.appendChild(titleDiv);
        contentDiv.appendChild(infoDiv);
        card.appendChild(contentDiv);
        card.onclick = () => openThread(thread.id);
        list.appendChild(card);
      });
    }
  }

  function countMessages(threadId, callback) {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index("threadId");
    let count = 0;
    index.openCursor(IDBKeyRange.only(threadId)).onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { count++; cursor.continue(); }
      else { callback(count); }
    };
  }

  // --- スレッド開閉 [13][14] ---
  function openThread(threadId) {
    currentThreadId = threadId;
    const tx = db.transaction("threads", "readonly");
    const store = tx.objectStore("threads");
    store.get(threadId).onsuccess = e => {
      const thread = e.target.result;
      if (thread) {
        const mTitle = document.getElementById("modalTitle");
        if (mTitle) mTitle.textContent = thread.title;
      }
    };
    document.getElementById("modal").classList.add("active");
    renderMessages();
  }

  function closeThread() {
    stopAllPlayback();
    currentThreadId = null;
    document.getElementById("modal").classList.remove("active");
  }

  const closeModalBtn = document.getElementById("closeModalBtn");
  if (closeModalBtn) closeModalBtn.onclick = closeThread;

  // --- 新規スレッド作成録音ロジック [14][15][16][17][18][19] ---
  const createModal = document.getElementById("createThreadModal");
  const startThreadRecordBtn = document.getElementById("startThreadRecordBtn");
  const saveThreadBtn = document.getElementById("saveThreadBtn");
  const threadTitleInput = document.getElementById("threadTitleInput");
  const titleInputArea = document.getElementById("titleInputArea");
  let threadAudioBlob = null;
  const newThreadBtn = document.getElementById("newThreadBtn");

  if (newThreadBtn) {
    newThreadBtn.onclick = () => {
      createModal.classList.add("active");
      startThreadRecordBtn.style.display = "inline-block";
      titleInputArea.style.display = "none";
      threadTitleInput.value = "";
      document.getElementById("recordBox").style.display = "none";
    };
  }

  if (startThreadRecordBtn) {
    startThreadRecordBtn.onclick = async () => {
      startThreadRecordBtn.style.display = "none";
      try {
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        sourceNode = audioContext.createMediaStreamSource(recordingStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        sourceNode.connect(analyser);
        dataArray = new Uint8Array(analyser.frequencyBinCount);
        drawLiveWave();

        let mimeType = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "audio/mp4" : "audio/webm";
        mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
        audioChunks = [];
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = () => {
          threadAudioBlob = new Blob(audioChunks, { type: mimeType });
          cleanupRecordingState();
          titleInputArea.style.display = "block";
          threadTitleInput.focus();
        };
        mediaRecorder.start();
        document.getElementById("recordBox").style.display = "block";
        startCountdown();
      } catch (err) {
        console.error("録音開始に失敗:", err);
        startThreadRecordBtn.style.display = "inline-block";
      }
    };
  }

  if (saveThreadBtn) {
    saveThreadBtn.onclick = () => {
      const title = threadTitleInput.value.trim();
      if (!title) return alert("タイトルを入力してください");
      const id = crypto.randomUUID();
      const now = Date.now();
      const tx = db.transaction(["threads", "messages"], "readwrite");
      tx.objectStore("threads").add({ id, title, lastUpdatedAt: now });
      tx.objectStore("messages").add({ id: crypto.randomUUID(), threadId: id, createdAt: now, blob: threadAudioBlob });
      tx.oncomplete = () => {
        createModal.classList.remove("active");
        threadTitleInput.value = ""; // ソース[19]を維持
        titleInputArea.style.display = "none";
        startThreadRecordBtn.disabled = false;
        renderThreads();
        updateCapacity();
      };
    };
  }

  // --- スレッド内返信録音 [19][20][21][22][23] ---
  function startRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      recordingStream = stream;
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      sourceNode.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      drawLiveWave();

      let mimeType = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "audio/mp4" : "audio/webm";
      mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunks = [];
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: mimeType });
        cleanupRecordingState();
        saveReplyBlob(blob);
      };
      mediaRecorder.start();
      document.getElementById("recordBox").style.display = "block";
      startCountdown();
    });
  }

  function stopRecording() {
    if (mediaRecorder) mediaRecorder.stop();
    if (recordBtn) recordBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
  }

  function saveReplyBlob(blob) {
    if (!currentThreadId) return;
    const id = crypto.randomUUID();
    const now = Date.now();
    const tx = db.transaction(["messages", "threads"], "readwrite");
    tx.objectStore("messages").add({ id, threadId: currentThreadId, createdAt: now, blob });
    const threadStore = tx.objectStore("threads");
    const getReq = threadStore.get(currentThreadId);
    getReq.onsuccess = () => {
      const thread = getReq.result;
      if (!thread) return;
      thread.lastUpdatedAt = now;
      threadStore.put(thread);
    };
    tx.oncomplete = () => {
      renderMessages();
      renderThreads();
      updateCapacity();
    };
  }

  function startCountdown() {
    let timeLeft = 5;
    document.getElementById("countdown").textContent = timeLeft;
    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      timeLeft--;
      document.getElementById("countdown").textContent = timeLeft;
      if (timeLeft <= 0) {
        clearInterval(countdownInterval);
        stopRecording();
      }
    }, 1000);
  }

  function cleanupRecordingState() {
    cancelAnimationFrame(animationId);
    if (audioContext) audioContext.close();
    if (recordingStream) recordingStream.getTracks().forEach(track => track.stop());
    document.getElementById("recordBox").style.display = "none";
    clearInterval(countdownInterval);
  }

  // --- 再生ロジック（最重要：スマホ再生バグ修正） [24][25][26][27][28][29][30][31][32] ---
  let currentAudio = null;
  let currentAudioContext = null;
  let currentAnimationId = null;
  let currentObjectURL = null;

  function renderMessages() {
    const list = document.getElementById("messageList");
    if (!list) return;
    list.innerHTML = "";
    const tx = db.transaction("messages", "readonly");
    const index = tx.objectStore("messages").index("threadId");
    const messages = [];

    index.openCursor(IDBKeyRange.only(currentThreadId)).onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) {
        messages.sort((a, b) => a.createdAt - b.createdAt).forEach((msg, idx) => {
          const div = document.createElement("div");
          div.className = "messageItem";
          div.dataset.msgId = msg.id;

          const orderLabel = document.createElement("div");
          orderLabel.className = "orderLabel";
          orderLabel.textContent = `${idx + 1}`;

          const timeLabel = document.createElement("div");
          timeLabel.className = "timeLabel";
          timeLabel.textContent = new Date(msg.createdAt).toLocaleTimeString();

          const playStopBtn = document.createElement("button");
          playStopBtn.textContent = "▶";

          const seekBar = document.createElement("input");
          seekBar.type = "range";
          seekBar.value = 0;
          seekBar.min = 0;
          seekBar.step = 0.01;

          const canvas = document.createElement("canvas");
          canvas.width = 300;
          canvas.height = 60;

          playStopBtn.onclick = () => {
            if (currentAudio === null) {
              // 解決策：再生直前にDBのBlobから新しいURLを生成 [28]
              playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, () => {
                playStopBtn.textContent = "▶";
                seekBar.value = 0;
              });
              playStopBtn.textContent = "■";
            } else {
              isPlayingAll = false;
              stopCurrentAudio();
              playStopBtn.textContent = "▶";
              seekBar.value = 0;
            }
          };

          seekBar.oninput = () => {
            if (currentAudio) currentAudio.currentTime = parseFloat(seekBar.value);
          };

          div.appendChild(orderLabel);
          div.appendChild(timeLabel);
          div.appendChild(playStopBtn);
          div.appendChild(seekBar);
          div.appendChild(canvas);
          list.appendChild(div);
        });
        return;
      }
      messages.push(cursor.value);
      cursor.continue();
    };
  }

  function playAudioFromBlob(blob, canvas, seekBar, playStopBtn, onEnded) {
    stopCurrentAudio();

    // 解決策1：MIMEタイプの補正とBlobの再生成 [28]
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const mimeType = isIOS ? "audio/mp4" : (blob.type || "audio/webm");
    const safeBlob = new Blob([blob], { type: mimeType });

    if (currentObjectURL) URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = URL.createObjectURL(safeBlob);

    const audio = new Audio();
    audio.src = currentObjectURL;
    audio.setAttribute("playsinline", "true");
    audio.preload = "auto";
    currentAudio = audio;

    // 解決策2：AudioContextの確実な再開 [28][29]
    if (!currentAudioContext) {
      currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (currentAudioContext.state === 'suspended') {
      currentAudioContext.resume();
    }

    audio.onloadedmetadata = () => {
      // 解決策3：録音データのduration Infinity対策
      if (audio.duration === Infinity) {
        audio.currentTime = 1e10; // 最後に飛ばして長さを強制計算
        audio.ontimeupdate = () => {
          audio.ontimeupdate = null;
          audio.currentTime = 0;
          seekBar.max = audio.duration;
        };
      } else {
        seekBar.max = audio.duration;
      }
    };

    audio.ontimeupdate = () => {
      seekBar.value = audio.currentTime;
    };

    audio.onended = () => {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      stopCurrentAudio();
      seekBar.value = 0;
      if (playStopBtn) playStopBtn.textContent = "▶";
      if (onEnded) onEnded();
    };

    // 可視化 [30][31]
    try {
      const source = currentAudioContext.createMediaElementSource(audio);
      const analyserNode = currentAudioContext.createAnalyser();
      analyserNode.fftSize = 256;
      const dataArr = new Uint8Array(analyserNode.frequencyBinCount);
      source.connect(analyserNode);
      analyserNode.connect(currentAudioContext.destination);

      const draw = () => {
        const ctx = canvas.getContext("2d");
        currentAnimationId = requestAnimationFrame(draw);
        analyserNode.getByteTimeDomainData(dataArr);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.lineWidth = 2; ctx.strokeStyle = "#00ff66"; ctx.beginPath();
        let x = 0; const sliceWidth = canvas.width / dataArr.length;
        for (let i = 0; i < dataArr.length; i++) {
          const v = dataArr[i] / 128.0; const y = (v * canvas.height) / 2;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          x += sliceWidth;
        }
        ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
      };
      draw();
    } catch (e) {
      console.warn("Visualizer issue:", e);
    }

    audio.play().catch(err => {
      console.error("Playback error:", err);
      currentAudioContext.resume().then(() => audio.play());
    });
  }

  function stopCurrentAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.onended = null;
      currentAudio.ontimeupdate = null;
      currentAudio = null;
    }
    if (currentAnimationId) {
      cancelAnimationFrame(currentAnimationId);
      currentAnimationId = null;
    }
  }

  // --- 連続再生 [32][33][34][35] ---
  function playAll() {
    if (isPlayingAll || !currentThreadId) return;
    stopCurrentAudio();
    isPlayingAll = true;
    if (!currentAudioContext) {
      currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    currentAudioContext.resume();

    const tx = db.transaction("messages", "readonly");
    const index = tx.objectStore("messages").index("threadId");
    const messages = [];
    index.openCursor(IDBKeyRange.only(currentThreadId)).onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) {
        if (messages.length === 0) { isPlayingAll = false; return; }
        messages.sort((a,b) => a.createdAt - b.createdAt);
        playSequential(messages);
        return;
      }
      messages.push(cursor.value);
      cursor.continue();
    };
  }

  function playSequential(messages) {
    if (!isPlayingAll || messages.length === 0) { isPlayingAll = false; return; }
    const msg = messages.shift();
    const item = document.querySelector(`#messageList .messageItem[data-msg-id="${msg.id}"]`);
    if (!item) { playSequential(messages); return; }

    const canvas = item.querySelector("canvas");
    const seekBar = item.querySelector("input[type=range]");
    const playStopBtn = item.querySelector("button");

    playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, () => {
      if (isPlayingAll) playSequential(messages);
    });
    if (playStopBtn) playStopBtn.textContent = "■";
  }

  function stopAllPlayback() {
    isPlayingAll = false;
    stopCurrentAudio();
  }

  // --- 容量表示 [35][36] ---
  function updateCapacity() {
    let total = 0;
    if (!db) return;
    const tx = db.transaction("messages", "readonly");
    tx.objectStore("messages").openCursor().onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) {
        const capDisp = document.getElementById("capacityDisplay");
        if (capDisp) capDisp.textContent = "使用容量：" + (total / 1024 / 1024).toFixed(1) + " MB";
        return;
      }
      if (cursor.value.blob) total += cursor.value.blob.size;
      cursor.continue();
    };
  }

  // --- 録音波形描画 [36][37] ---
  function drawLiveWave() {
    const canvas = document.getElementById("waveCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    animationId = requestAnimationFrame(drawLiveWave);
    analyser.getByteTimeDomainData(dataArray);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2; ctx.strokeStyle = "#00ff99"; ctx.beginPath();
    const sliceWidth = canvas.width / dataArray.length;
    let x = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] / 128.0; const y = (v * canvas.height) / 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
  }

  if (recordBtn) recordBtn.onclick = startRecording;
  if (stopBtn) stopBtn.onclick = stopRecording;
});
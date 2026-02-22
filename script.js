document.addEventListener("DOMContentLoaded", () => {

let db;
let currentThreadId = null;
let mediaRecorder;
let audioChunks = [];
let isPlayingAll = false;
let audioQueue = [];

const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const playAllBtn = document.getElementById("playAllBtn");
playAllBtn.onclick = playAll;
const deleteThreadBtn = document.getElementById("deleteThreadBtn");
deleteThreadBtn.onclick = deleteCurrentThread;

const request = indexedDB.open("voiceAppDB", 2);

request.onupgradeneeded = e => {
  db = e.target.result;

  const threadStore = db.createObjectStore("threads", { keyPath: "id" });
  threadStore.createIndex("title", "title");
  threadStore.createIndex("lastUpdatedAt", "lastUpdatedAt");

  const messageStore = db.createObjectStore("messages", { keyPath: "id" });
  messageStore.createIndex("threadId", "threadId");
  messageStore.createIndex("createdAt", "createdAt");
};

request.onsuccess = e => {
  db = e.target.result;
  renderThreadsByReplyCount(); // 件数順で描画
  updateCapacity();
};

function todayString() {
  return new Date().toISOString().split("T")[0];
}
function deleteCurrentThread() {
  if (!currentThreadId) return;

  // 確認ダイアログを追加
  const confirmed = confirm("本当に削除しますか？");
  if (!confirmed) return; // キャンセルされたら処理中断

  const tx = db.transaction(["threads", "messages"], "readwrite");

  // メッセージ削除
  const msgStore = tx.objectStore("messages");
  const index = msgStore.index("threadId");

  index.openCursor(IDBKeyRange.only(currentThreadId)).onsuccess = e => {
    const cursor = e.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  // スレッド削除
  tx.objectStore("threads").delete(currentThreadId);

  tx.oncomplete = () => {
    closeThread();
    renderThreads();
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
  
        // 既存スレッドを取得してから更新
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
  function renderThreads() {
    const list = document.getElementById("threadList");
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
  
      // 件数を非同期で取得
      countMessages(thread.id, count => {
        card.textContent = `${thread.title} (${new Date(thread.lastUpdatedAt).toLocaleString()}) - レス ${count} 件`;
      });
  
      card.onclick = () => openThread(thread.id);
      list.appendChild(card);
  
      cursor.continue();
    };
  }
  // 件数でソートして表示する例
const searchInput = document.getElementById("threadSearchInput");

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const query = searchInput.value.trim();
    renderThreadsByReplyCount(query);
  }
});

function renderThreadsByReplyCount(filterText = "") {
  const list = document.getElementById("threadList");
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
      titleDiv.textContent = thread.title;  // ここで直接セット
    
      const infoDiv = document.createElement("div");
      infoDiv.className = "threadInfo";
      infoDiv.textContent = `${new Date(thread.lastUpdatedAt).toLocaleString()} - レス ${count} 件`;  // ここも直接セット
    
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
    if (cursor) {
      count++;
      cursor.continue();
    } else {
      callback(count);
    }
  };
}
function openThread(threadId) {
  currentThreadId = threadId;
  
  const tx = db.transaction("threads", "readonly");
  const store = tx.objectStore("threads");
  store.get(threadId).onsuccess = e => {
    const thread = e.target.result;
    if (thread) {
      // モーダルタイトルをスレッド名に更新
      document.getElementById("modalTitle").textContent = thread.title;
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

document.getElementById("closeModalBtn").onclick = closeThread;

const createModal = document.getElementById("createThreadModal");
const startThreadRecordBtn = document.getElementById("startThreadRecordBtn");
const saveThreadBtn = document.getElementById("saveThreadBtn");
const threadTitleInput = document.getElementById("threadTitleInput");
const titleInputArea = document.getElementById("titleInputArea");

let threadAudioBlob = null;

document.getElementById("newThreadBtn").onclick = () => {
  createModal.classList.add("active");

  // 新規スレッド開始時に録音ボタンを再表示
  startThreadRecordBtn.style.display = "inline-block";

  // タイトル入力欄は非表示に戻す
  titleInputArea.style.display = "none";
  threadTitleInput.value = "";

  // カウントダウンや波形もリセット
  document.getElementById("recordBox").style.display = "none";
};

startThreadRecordBtn.onclick = async () => {
  // 録音開始時はボタンを非表示
  startThreadRecordBtn.style.display = "none";

  recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  // ===== AudioContext（波形用） =====
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioContext.createMediaStreamSource(recordingStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;

  sourceNode.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);

  drawLiveWave(); // リアルタイム描画開始

  // ===== MediaRecorder（録音保存用） =====
  let mimeType = "audio/webm";
if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  mimeType = "audio/mp4"; // iOS対応
}
mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
  audioChunks = [];

  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

  mediaRecorder.onstop = () => {
    threadAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
  
    // 録音用UIは非表示
    document.getElementById("recordBox").style.display = "none";
  
    // タイトル入力欄を表示
    titleInputArea.style.display = "block";
  
    // 自動で入力欄にフォーカス
    threadTitleInput.focus();
  };

  mediaRecorder.start();

  document.getElementById("recordBox").style.display = "block";

  // ===== 5秒カウントダウン =====
  let timeLeft = 5;
  document.getElementById("countdown").textContent = timeLeft;

  countdownInterval = setInterval(() => {
    timeLeft--;
    document.getElementById("countdown").textContent = timeLeft;

    if (timeLeft <= 0) {
      clearInterval(countdownInterval);
      mediaRecorder.stop();
    }
  }, 1000);
};


saveThreadBtn.onclick = () => {
  const title = threadTitleInput.value.trim();
  if (!title) return alert("タイトルを入力してください");

  const id = crypto.randomUUID();
  const now = Date.now();

  const tx = db.transaction(["threads", "messages"], "readwrite");

  tx.objectStore("threads").add({
    id,
    title,
    lastUpdatedAt: now
  });

  tx.objectStore("messages").add({
    id: crypto.randomUUID(),
    threadId: id,
    createdAt: now,
    blob: threadAudioBlob
  });

  tx.oncomplete = () => {
    createModal.classList.remove("active");
    threadTitleInput.value = "";
    titleInputArea.style.display = "none";
    startThreadRecordBtn.disabled = false;
    renderThreads();
  };
};

let countdownInterval;
let audioBlob;
let audioContext;
let analyser;
let dataArray;
let animationId;
let sourceNode;
let recordingStream;

function startRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") return; // 多重録音防止
  
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      recordingStream = stream;
  
      // 波形用 AudioContext
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      sourceNode.connect(analyser);
  
      const bufferLength = analyser.frequencyBinCount;
      dataArray = new Uint8Array(bufferLength);
  
      drawLiveWave(); // リアルタイム波形描画開始
  
      // MediaRecorder
      let mimeType = "audio/webm";
if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  mimeType = "audio/mp4"; // iOS対応
}
mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunks = [];
  
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: "audio/webm" });
  
        cancelAnimationFrame(animationId);
        audioContext.close();
        stream.getTracks().forEach(track => track.stop());
  
        document.getElementById("recordBox").style.display = "none";
        // 保存やUI更新はここで行う
        saveReplyBlob(blob);
      };
  
      mediaRecorder.start();
  
      document.getElementById("recordBox").style.display = "block";
  
      // 10秒カウントダウン
      let timeLeft = 5;
      document.getElementById("countdown").textContent = timeLeft;
  
      countdownInterval = setInterval(() => {
        timeLeft--;
        document.getElementById("countdown").textContent = timeLeft;
  
        if (timeLeft <= 0) {
          clearInterval(countdownInterval);
          mediaRecorder.stop();
        }
      }, 1000);
    });
  }
function stopRecording() {
  mediaRecorder.stop();
  recordBtn.disabled = false;
  stopBtn.disabled = true;
}

function saveReplyBlob(blob) {
    if (!currentThreadId) return;
  
    const id = crypto.randomUUID();
    const now = Date.now();
  
    const tx = db.transaction(["messages", "threads"], "readwrite");
    tx.objectStore("messages").add({
      id,
      threadId: currentThreadId,
      createdAt: now,
      blob
    });
  
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
  function renderMessages() {
    const list = document.getElementById("messageList");
    list.innerHTML = "";
  
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index("threadId");
    const messages = [];
  
    index.openCursor(IDBKeyRange.only(currentThreadId)).onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) {
        messages.sort((a, b) => a.createdAt - b.createdAt);

        messages.forEach((msg, index) => { // index が 0 から始まる順番
          const div = document.createElement("div");
          div.className = "messageItem";
          div.dataset.msgId = msg.id;
        
          // 順番ラベル
          const orderLabel = document.createElement("div");
          orderLabel.className = "orderLabel";
          orderLabel.textContent = `${index + 1}`; // 1始まり
        
          const timeLabel = document.createElement("div");
          timeLabel.className = "timeLabel";
          timeLabel.textContent = new Date(msg.createdAt).toLocaleTimeString();
        
          // 再生ボタン、シークバー、キャンバスは既存通り
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
              playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, () => {});
              playStopBtn.textContent = "■";
            } else {
              stopCurrentAudio();
              playStopBtn.textContent = "▶";
              seekBar.value = 0;
            }
          };
        
          seekBar.oninput = () => {
            if (currentAudio) currentAudio.currentTime = parseFloat(seekBar.value);
          };
        
          // div に順番ラベルを先頭に追加
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
  let currentAudio = null;
let currentAudioContext = null;
let currentAnimationId = null;

function playAudioFromBlob(blob, canvas, seekBar, playStopBtn, onEnded) {
  stopCurrentAudio();

  const audio = new Audio(URL.createObjectURL(blob));
  currentAudio = audio;

  audio.currentTime = parseFloat(seekBar.value) || 0;

  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  currentAudioContext = audioContext;
  const source = audioContext.createMediaElementSource(audio);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);
  analyser.connect(audioContext.destination);

  // 再生前から高さは確保しているので、displayは常にblock
  canvas.style.display = "block";

  function draw() {
    const ctx = canvas.getContext("2d");
    currentAnimationId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    // 背景を透明にして余白を確保
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#00ff66"; // 緑系

    ctx.beginPath();
    const sliceWidth = canvas.width / dataArray.length;
    let x = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * canvas.height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }
  draw();

  audio.ontimeupdate = () => {
    seekBar.value = audio.currentTime;
  };

  audio.onloadedmetadata = () => {
    seekBar.max = audio.duration;
  };

  audio.onended = () => {
    // 再生終了時は線だけ消す（高さは維持）
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // canvas自体は非表示にしない → 余白は維持
    stopCurrentAudio();
    seekBar.value = 0;
    if (playStopBtn) playStopBtn.textContent = "▶";
    if (onEnded) onEnded();
  };

  audio.play();
}
function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    // currentAudio.currentTime = 0; // ←削除してシークバー位置を保持
    currentAudio = null;
  }
  if (currentAnimationId) {
    cancelAnimationFrame(currentAnimationId);
    currentAnimationId = null;
  }
  if (currentAudioContext) {
    currentAudioContext.close();
    currentAudioContext = null;
  }
}

function playAll() {
  if (isPlayingAll || !currentThreadId) return;

  // 個別再生中なら停止
  stopCurrentAudio();

  isPlayingAll = true;

  const tx = db.transaction("messages", "readonly");
  const store = tx.objectStore("messages");
  const index = store.index("threadId");
  const messages = [];

  index.openCursor(IDBKeyRange.only(currentThreadId)).onsuccess = e => {
    const cursor = e.target.result;
    if (!cursor) {
      if (messages.length === 0) {
        isPlayingAll = false;
        return;
      }

      messages.sort((a,b) => a.createdAt - b.createdAt);
      playSequential(messages);
      return;
    }
    messages.push(cursor.value);
    cursor.continue();
  };
}

  function playSequential(messages) {
    if (messages.length === 0) {
      isPlayingAll = false;
      return;
    }
  
    const msg = messages.shift();
  
    // DOM を id で取得
    const item = document.querySelector(`#messageList .messageItem[data-msg-id="${msg.id}"]`);
    if (!item) {
      // DOM が見つからなければ次へ
      playSequential(messages);
      return;
    }
  
    const canvas = item.querySelector("canvas");
    const seekBar = item.querySelector("input[type=range]");
    const playStopBtn = item.querySelector("button"); // ← 再生ボタンを取得
  
    // 再生終了時のコールバック
    const onEnded = () => playSequential(messages);
  
    // 再生ボタンを使って通常再生と同じ処理
    playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, onEnded);
  
    // ボタン表示も「停止」に変更
    playStopBtn.textContent = "■";
  }
function stopAllPlayback() {
  isPlayingAll = false;
}

function updateCapacity() {
  let total = 0;

  const tx = db.transaction("messages", "readonly");
  tx.objectStore("messages").openCursor().onsuccess = e => {
    const cursor = e.target.result;
    if (!cursor) {
      document.getElementById("capacityDisplay").textContent =
        "使用容量：" + (total / 1024 / 1024).toFixed(1) + " MB";
      return;
    }
    total += cursor.value.blob.size;
    cursor.continue();
  };
}
function playAudio(blob) {
    const audio = new Audio(URL.createObjectURL(blob));
    audio.play();
  
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaElementSource(audio);
  
    analyser = audioContext.createAnalyser();
    source.connect(analyser);
    analyser.connect(audioContext.destination);
  
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
  
    drawWave();
  
    audio.onended = () => {
      cancelAnimationFrame(animationId);
    };
  }
  
  // ▲▲ 追加ここまで ▲▲
  function drawLiveWave() {
    const canvas = document.getElementById("waveCanvas");
    const ctx = canvas.getContext("2d");
  
    animationId = requestAnimationFrame(drawLiveWave);
  
    analyser.getByteTimeDomainData(dataArray);
  
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#00ff99";
    ctx.beginPath();
  
    const sliceWidth = canvas.width / dataArray.length;
    let x = 0;
  
    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * canvas.height) / 2;
  
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
  
      x += sliceWidth;
    }
  
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

recordBtn.onclick = startRecording;
stopBtn.onclick = stopRecording;
playAllBtn.onclick = playAll;
});
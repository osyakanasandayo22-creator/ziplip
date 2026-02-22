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
      // 初期表示は件数順
      renderThreadsByReplyCount(); 
      updateCapacity();
  };

  function todayString() {
      return new Date().toISOString().split("T");
  }

  // スレッド削除
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
          renderThreads(); // 更新
          updateCapacity();
      };
  }

  // メッセージ削除後のスレッド更新
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

  // 【修正ポイント】スレッドリストの描画（CSS構造を維持）
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

          countMessages(thread.id, count => {
              // スレッドの中身を単純なテキストにせず、CSSが効くようにHTML構造を作成
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

  // 検索・ソート表示
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
      startThreadRecordBtn.style.display = "inline-block";
      titleInputArea.style.display = "none";
      threadTitleInput.value = "";
      document.getElementById("recordBox").style.display = "none";
  };

  // 新規スレッド用録音
  startThreadRecordBtn.onclick = async () => {
      startThreadRecordBtn.style.display = "none";
      recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioContext.createMediaStreamSource(recordingStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      sourceNode.connect(analyser);
      const bufferLength = analyser.frequencyBinCount;
      dataArray = new Uint8Array(bufferLength);
      drawLiveWave();

      let mimeType = "audio/webm";
      if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
          mimeType = "audio/mp4"; 
      }
      mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
      audioChunks = [];
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
          // iOS対応修正
          threadAudioBlob = new Blob(audioChunks, { type: mimeType });
          document.getElementById("recordBox").style.display = "none";
          titleInputArea.style.display = "block";
          threadTitleInput.focus();
      };

      mediaRecorder.start();
      document.getElementById("recordBox").style.display = "block";
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
      tx.objectStore("threads").add({ id, title, lastUpdatedAt: now });
      tx.objectStore("messages").add({
          id: crypto.randomUUID(),
          threadId: id,
          createdAt: now,
          blob: threadAudioBlob
      });
      tx.oncomplete = () => {
          createModal.classList.remove("active");
          renderThreads(); // 更新
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

  // 返信録音
  function startRecording() {
      if (mediaRecorder && mediaRecorder.state === "recording") return;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
          recordingStream = stream;
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
          sourceNode = audioContext.createMediaStreamSource(stream);
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 2048;
          sourceNode.connect(analyser);
          const bufferLength = analyser.frequencyBinCount;
          dataArray = new Uint8Array(bufferLength);
          drawLiveWave();

          let mimeType = "audio/webm";
          if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
              mimeType = "audio/mp4";
          }
          mediaRecorder = new MediaRecorder(stream, { mimeType });
          audioChunks = [];
          mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
          mediaRecorder.onstop = () => {
              // iOS対応修正
              const blob = new Blob(audioChunks, { type: mimeType });
              cancelAnimationFrame(animationId);
              audioContext.close();
              stream.getTracks().forEach(track => track.stop());
              document.getElementById("recordBox").style.display = "none";
              saveReplyBlob(blob);
          };

          mediaRecorder.start();
          document.getElementById("recordBox").style.display = "block";
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
      if (mediaRecorder) mediaRecorder.stop();
  }

  function saveReplyBlob(blob) {
      if (!currentThreadId) return;
      const now = Date.now();
      const tx = db.transaction(["messages", "threads"], "readwrite");
      tx.objectStore("messages").add({ 
          id: crypto.randomUUID(), 
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
          renderThreads(); // スレッド一覧も更新
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
              messages.forEach((msg, index) => {
                  const div = document.createElement("div");
                  div.className = "messageItem";
                  div.dataset.msgId = msg.id;
                  const orderLabel = document.createElement("div");
                  orderLabel.className = "orderLabel";
                  orderLabel.textContent = `${index + 1}`;
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
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      currentAudioContext = audioContext;
      const source = audioContext.createMediaElementSource(audio);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      canvas.style.display = "block";

      function draw() {
          const ctx = canvas.getContext("2d");
          currentAnimationId = requestAnimationFrame(draw);
          analyser.getByteTimeDomainData(dataArray);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#00ff66";
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

      audio.ontimeupdate = () => { seekBar.value = audio.currentTime; };
      audio.onloadedmetadata = () => { seekBar.max = audio.duration; };
      audio.onended = () => {
          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          stopCurrentAudio();
          seekBar.value = 0;
          if (playStopBtn) playStopBtn.textContent = "▶";
          if (onEnded) onEnded();
      };

      // iOS再生対応
      audio.play().then(() => {
          if (audioContext.state === 'suspended') {
              audioContext.resume();
          }
      }).catch(e => console.error("Playback failed:", e));
  }

  function stopCurrentAudio() {
      if (currentAudio) { currentAudio.pause(); currentAudio = null; }
      if (currentAnimationId) { cancelAnimationFrame(currentAnimationId); currentAnimationId = null; }
      if (currentAudioContext) { currentAudioContext.close(); currentAudioContext = null; }
  }

  function playAll() {
      if (isPlayingAll || !currentThreadId) return;
      stopCurrentAudio();
      isPlayingAll = true;
      const tx = db.transaction("messages", "readonly");
      const store = tx.objectStore("messages");
      const index = store.index("threadId");
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
      if (messages.length === 0) { isPlayingAll = false; return; }
      const msg = messages.shift();
      const item = document.querySelector(`#messageList .messageItem[data-msg-id="${msg.id}"]`);
      if (!item) { playSequential(messages); return; }
      const canvas = item.querySelector("canvas");
      const seekBar = item.querySelector("input[type=range]");
      const playStopBtn = item.querySelector("button");
      const onEnded = () => playSequential(messages);
      playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, onEnded);
      playStopBtn.textContent = "■";
  }

  function stopAllPlayback() { isPlayingAll = false; }

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
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          x += sliceWidth;
      }
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
  }

  recordBtn.onclick = startRecording;
  stopBtn.onclick = stopRecording;
});
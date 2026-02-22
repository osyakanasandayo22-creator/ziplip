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
  const deleteThreadBtn = document.getElementById("deleteThreadBtn");

  // イベントリスナーの設定 [4, 5]
  playAllBtn.onclick = playAll;
  deleteThreadBtn.onclick = deleteCurrentThread;
  recordBtn.onclick = startRecording;
  stopBtn.onclick = stopRecording;

  const request = indexedDB.open("voiceAppDB", 2); [4]

  request.onupgradeneeded = e => { [6]
      db = e.target.result;
      const threadStore = db.createObjectStore("threads", { keyPath: "id" });
      threadStore.createIndex("title", "title");
      threadStore.createIndex("lastUpdatedAt", "lastUpdatedAt");
      const messageStore = db.createObjectStore("messages", { keyPath: "id" });
      messageStore.createIndex("threadId", "threadId");
      messageStore.createIndex("createdAt", "createdAt");
  };

  request.onsuccess = e => { [6]
      db = e.target.result;
      renderThreadsByReplyCount();
      updateCapacity();
  };

  function todayString() { [7]
      return new Date().toISOString().split("T");
  }

  function deleteCurrentThread() { [7, 8]
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
          renderThreads();
          updateCapacity();
      };
  }

  function deleteMessage(messageId) { [8]
      const tx = db.transaction(["messages", "threads"], "readwrite");
      const msgStore = tx.objectStore("messages");
      msgStore.delete(messageId);
      tx.oncomplete = () => {
          recalculateThreadUpdatedAt(currentThreadId);
      };
  }

  function recalculateThreadUpdatedAt(threadId) { [8-10]
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

  function renderThreads() { [10-12]
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

  const searchInput = document.getElementById("threadSearchInput"); [12]
  searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
          const query = searchInput.value.trim();
          renderThreadsByReplyCount(query);
      }
  });

  function renderThreadsByReplyCount(filterText = "") { [13-15]
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

  function countMessages(threadId, callback) { [15, 16]
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

  function openThread(threadId) { [16, 17]
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

  function closeThread() { [17]
      stopAllPlayback();
      currentThreadId = null;
      document.getElementById("modal").classList.remove("active");
  }

  document.getElementById("closeModalBtn").onclick = closeThread;

  const createModal = document.getElementById("createThreadModal"); [17, 18]
  const startThreadRecordBtn = document.getElementById("startThreadRecordBtn");
  const saveThreadBtn = document.getElementById("saveThreadBtn");
  const threadTitleInput = document.getElementById("threadTitleInput");
  const titleInputArea = document.getElementById("titleInputArea");
  let threadAudioBlob = null;

  document.getElementById("newThreadBtn").onclick = () => { [18]
      createModal.classList.add("active");
      startThreadRecordBtn.style.display = "inline-block";
      titleInputArea.style.display = "none";
      threadTitleInput.value = "";
      document.getElementById("recordBox").style.display = "none";
  };

  startThreadRecordBtn.onclick = async () => { [18-20]
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

      let mimeType = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "audio/mp4" : "audio/webm";
      mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
      audioChunks = [];
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
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

  saveThreadBtn.onclick = () => { [21, 22]
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
          threadTitleInput.value = "";
          titleInputArea.style.display = "none";
          startThreadRecordBtn.disabled = false;
          renderThreads();
      };
  };

  let countdownInterval, audioBlob, audioContext, analyser, dataArray, animationId, sourceNode, recordingStream;

  function startRecording() { [22-25]
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

  function stopRecording() { [25]
      mediaRecorder.stop();
      recordBtn.disabled = false;
      stopBtn.disabled = true;
  }

  function saveReplyBlob(blob) { [25, 26]
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

  function renderMessages() { [26-30]
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
              messages.forEach((msg, idx) => {
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
                          playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, () => {});
                          playStopBtn.textContent = "■";
                      } else {
                          isPlayingAll = false; // 個別停止時に連続再生を止める [3]
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

  function playAudioFromBlob(blob, canvas, seekBar, playStopBtn, onEnded) { [30-33]
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
      audio.play().then(() => {
          if (audioContext.state === 'suspended') audioContext.resume();
      }).catch(e => console.error("Playback failed:", e));
  }

  function stopCurrentAudio() { [1, 33]
      if (currentAudio) {
          currentAudio.pause();
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

  function playAll() { [1, 2]
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
              if (messages.length === 0) {
                  isPlayingAll = false;
                  return;
              }
              messages.sort((a, b) => a.createdAt - b.createdAt);
              playSequential(messages);
              return;
          }
          messages.push(cursor.value);
          cursor.continue();
      };
  }

  function playSequential(messages) { [2, 3]
      // フラグが降りていたり、キューが空なら終了
      if (!isPlayingAll || messages.length === 0) {
          isPlayingAll = false;
          return;
      }

      const msg = messages.shift();
      const item = document.querySelector(`#messageList .messageItem[data-msg-id="${msg.id}"]`);
      
      if (!item) {
          playSequential(messages);
          return;
      }

      const canvas = item.querySelector("canvas");
      const seekBar = item.querySelector("input[type=range]");
      const playStopBtn = item.querySelector("button");

      const onEnded = () => {
          if (isPlayingAll) playSequential(messages);
      };

      playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, onEnded);
      playStopBtn.textContent = "■";
  }

  function stopAllPlayback() { [3]
      isPlayingAll = false;
      stopCurrentAudio(); // 実際に音を止める
  }

  function updateCapacity() { [3, 34]
      let total = 0;
      const tx = db.transaction("messages", "readonly");
      tx.objectStore("messages").openCursor().onsuccess = e => {
          const cursor = e.target.result;
          if (!cursor) {
              document.getElementById("capacityDisplay").textContent = "使用容量：" + (total / 1024 / 1024).toFixed(1) + " MB";
              return;
          }
          total += cursor.value.blob.size;
          cursor.continue();
      };
  }

  function drawLiveWave() { [5, 34]
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
});
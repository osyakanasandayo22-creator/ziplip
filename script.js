document.addEventListener("DOMContentLoaded", () => {
    let db;
    let currentThreadId = null;
    let mediaRecorder;
    let audioChunks = [];
    let isPlayingAll = false;

    const recordBtn = document.getElementById("recordBtn");
    const stopBtn = document.getElementById("stopBtn");
    const playAllBtn = document.getElementById("playAllBtn");
    if (playAllBtn) playAllBtn.onclick = playAll;

    const deleteThreadBtn = document.getElementById("deleteThreadBtn");
    if (deleteThreadBtn) deleteThreadBtn.onclick = deleteCurrentThread;

    // IndexedDBの初期化
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
        renderThreadsByReplyCount();
        updateCapacity();
    };

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
            renderThreads();
            updateCapacity();
        };
    }

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
    }

    if (saveThreadBtn) {
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
                threadTitleInput.value = "";
                titleInputArea.style.display = "none";
                startThreadRecordBtn.disabled = false;
                renderThreads();
            };
        };
    }

    let countdownInterval;
    let audioContext;
    let analyser;
    let dataArray;
    let animationId;
    let sourceNode;
    let recordingStream;

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
                const blob = new Blob(audioChunks, { type: mimeType });
                cancelAnimationFrame(animationId);
                if (audioContext) audioContext.close();
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
        recordBtn.disabled = false;
        stopBtn.disabled = true;
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

    function renderMessages() {
        const list = document.getElementById("messageList");
        if (!list) return;
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
                        // iOS/Safari対策: ユーザー操作の直後にAudioContextを即時レジューム
                        if (!currentAudioContext) {
                            currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                        }
                        if (currentAudioContext.state === 'suspended') {
                            currentAudioContext.resume();
                        }

                        if (currentAudio === null) {
                            playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, () => {});
                            playStopBtn.textContent = "■";
                        } else {
                            isPlayingAll = false;
                            stopCurrentAudio();
                            playStopBtn.textContent = "▶";
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
    let currentObjectURL = null;

    async function playAudioFromBlob(blob, canvas, seekBar, playStopBtn, onEnded) {
        stopCurrentAudio();

        if (currentObjectURL) {
            URL.revokeObjectURL(currentObjectURL);
        }

        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        const mimeType = isIOS ? "audio/mp4" : (blob.type || "audio/webm");
        
        try {
            // 再起動後のBlobを強制的に再認識させる
            const arrayBuffer = await blob.arrayBuffer();
            const safeBlob = new Blob([arrayBuffer], { type: mimeType });
            currentObjectURL = URL.createObjectURL(safeBlob);

            const audio = new Audio();
            audio.src = currentObjectURL;
            audio.setAttribute("playsinline", "true");
            audio.preload = "auto";
            currentAudio = audio;

            const audioCtx = currentAudioContext || new (window.AudioContext || window.webkitAudioContext)();
            currentAudioContext = audioCtx;
            
            const source = audioCtx.createMediaElementSource(audio);
            const analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 256;
            const dataArr = new Uint8Array(analyserNode.frequencyBinCount);
            source.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);

            audio.onloadedmetadata = () => {
                seekBar.max = audio.duration;
                seekBar.value = 0;
            };

            audio.ontimeupdate = () => {
                if (!isNaN(audio.currentTime)) {
                    seekBar.value = audio.currentTime;
                }
            };

            audio.onended = () => {
                stopCurrentAudio();
                if (playStopBtn) playStopBtn.textContent = "▶";
                if (onEnded) onEnded();
            };

            canvas.style.display = "block";
            const draw = () => {
                const ctx = canvas.getContext("2d");
                currentAnimationId = requestAnimationFrame(draw);
                analyserNode.getByteTimeDomainData(dataArr);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.lineWidth = 2;
                ctx.strokeStyle = "#00ff66";
                ctx.beginPath();
                const sliceWidth = canvas.width / dataArr.length;
                let x = 0;
                for (let i = 0; i < dataArr.length; i++) {
                    const v = dataArr[i] / 128.0;
                    const y = (v * canvas.height) / 2;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                    x += sliceWidth;
                }
                ctx.lineTo(canvas.width, canvas.height / 2);
                ctx.stroke();
            };
            draw();

            audio.load();
            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.error("Playback failed:", error);
                    // 失敗時のセーフティ
                    audioCtx.resume().then(() => audio.play());
                });
            }

        } catch (e) {
            console.error("Audio Load Error:", e);
        }
    }

    function stopCurrentAudio() {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }
        if (currentAnimationId) {
            cancelAnimationFrame(currentAnimationId);
            currentAnimationId = null;
        }
    }

    function playAll() {
        if (isPlayingAll || !currentThreadId) return;
        stopCurrentAudio();
        isPlayingAll = true;

        if (!currentAudioContext) {
            currentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        currentAudioContext.resume();

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

    async function playSequential(messages) {
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
        await playAudioFromBlob(msg.blob, canvas, seekBar, playStopBtn, onEnded);
        if (playStopBtn) playStopBtn.textContent = "■";
    }

    function stopAllPlayback() {
        isPlayingAll = false;
        stopCurrentAudio();
    }

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
            if (cursor.value.blob) {
                total += cursor.value.blob.size;
            }
            cursor.continue();
        };
    }

    function drawLiveWave() {
        const canvas = document.getElementById("waveCanvas");
        if (!canvas) return;
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

    if (recordBtn) recordBtn.onclick = startRecording;
    if (stopBtn) stopBtn.onclick = stopRecording;
});
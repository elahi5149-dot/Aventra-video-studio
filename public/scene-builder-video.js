document.addEventListener("DOMContentLoaded", () => {
  const el = id => document.getElementById(id);
  const status = el("sbStatus");
  const button = el("sbBuildVideo");
  if (!button || button.dataset.videoReady) return;
  button.dataset.videoReady = "1";

  button.onclick = async () => {
    try {
      const script = el("sbScript").value.trim();
      if (!script) throw Error("Please generate a script first.");

      button.disabled = true;
      el("sbGallery").innerHTML = "";
      el("sbVideo").style.display = "none";
      status.textContent = "Preparing scenes...";

      const chunks = script.split(/\n+/).map(x => x.trim()).filter(Boolean);
      const parts = [];
      for (let i = 0; i < 4; i++) {
        const text = chunks.length
          ? chunks[Math.floor(i * chunks.length / 4)] || chunks[0]
          : script;
        parts.push({
          scene: i + 1,
          summary: text.slice(0, 180),
          prompt: `${el("sbGenre").value} cinematic scene, ${text.slice(0, 500)}, dramatic lighting, 16:9 landscape, no text`,
          duration: 5
        });
      }

      const call = (url, options) => window.aventraFetch(url, options);
      const post = data => ({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });

      const r = await call("/api/youtube/generate-images", post({ scenes: parts }));
      const job = await r.json();
      if (!r.ok || !job.jobId) throw Error(job.message || "Could not start image generation.");

      status.textContent = "Generating scene images...";
      let result;
      for (let i = 0; i < 120; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const p = await call("/api/youtube/image-jobs/" + encodeURIComponent(job.jobId));
        result = await p.json();
        status.textContent = `Scenes: ${result.completed || 0}/${result.total || parts.length}`;
        if (result.status === "completed" || result.status === "failed") break;
      }

      const images = (result && result.images || []).filter(x => x.imageUrl);
      images.forEach(item => {
        const img = document.createElement("img");
        img.src = item.imageUrl.startsWith("http")
          ? item.imageUrl : new URL(item.imageUrl, "https://aventra-video-studio.onrender.com").href;
        img.alt = item.summary || "Generated scene";
        img.style.cssText = "width:48%;margin:1%;border-radius:8px";
        el("sbGallery").appendChild(img);
      });

      if (!images.length) throw Error("No scene images were generated. Check the image-generation status.");

      status.textContent = "Creating video with voice-over...";
      const v = await call("/api/youtube/create-video", post({
        scenes: images,
        voiceText: script,
        voice: el("sbLanguage").value === "Urdu" ? "ur-PK-UzmaNeural" : "en-US-AriaNeural"
      }));
      const video = await v.json();
      if (!v.ok || !video.videoUrl) throw Error(video.message || video.error || "Video creation failed.");

      const player = el("sbVideo");
      player.src = video.videoUrl.startsWith("http")
        ? video.videoUrl : new URL(video.videoUrl, "https://aventra-video-studio.onrender.com").href;
      player.style.display = "block";
      status.textContent = "Video created successfully!";
    } catch (e) {
      status.textContent = "Error: " + e.message;
    } finally {
      button.disabled = false;
    }
  };
});

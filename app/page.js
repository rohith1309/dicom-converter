'use client';

import { useState, useRef } from 'react';
import dicomParser from 'dicom-parser';

export default function CardioDicomSaaS() {
  // Navigation & Auth Modal State
  const [menuOpen, setMenuOpen] = useState(false);
  const [authModal, setAuthModal] = useState(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authNotice, setAuthNotice] = useState('');

  // Batch DICOM Converter State
  // Each item: { id, file, name, sizeMB, isVideo, frameCount, dimensions, encodingInfo, format, status, progress, downloadUrl, error }
  const [queue, setQueue] = useState([]);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [defaultVideoFormat, setDefaultVideoFormat] = useState('mp4');

  const ffmpegRef = useRef(null);
  const converterSectionRef = useRef(null);

  const scrollToConverter = () => {
    setMenuOpen(false);
    converterSectionRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleAuthSubmit = (e) => {
    e.preventDefault();
    setAuthNotice('Sign-in UI is ready. You can currently use the batch converter freely without an account.');
  };

  // Parse multiple uploaded DICOM files and add to queue
  const handleFilesUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length === 0) return;

    const parsedItems = await Promise.all(
      selectedFiles.map(async (uploadedFile, idx) => {
        const id = `${Date.now()}-${idx}-${uploadedFile.name}`;
        try {
          const arrayBuffer = await uploadedFile.arrayBuffer();
          const byteArray = new Uint8Array(arrayBuffer);
          const dataSet = dicomParser.parseDicom(byteArray);

          const frames = dataSet.intString('x00280008') || 1;
          const rows = dataSet.uint16('x00280010') || 0;
          const cols = dataSet.uint16('x00280011') || 0;
          const photometric = (dataSet.string('x00280004') || 'MONOCHROME2').trim();
          const pixelDataElement = dataSet.elements.x7fe00010;
          const isEncapsulated = Boolean(pixelDataElement?.encapsulatedPixelData);
          const isVideo = frames > 1;

          return {
            id,
            file: uploadedFile,
            name: uploadedFile.name,
            sizeMB: (uploadedFile.size / (1024 * 1024)).toFixed(2),
            isVideo,
            frameCount: frames,
            dimensions: `${cols} × ${rows} px`,
            encodingInfo: `${isEncapsulated ? 'Compressed JPEG' : 'Raw'} • ${photometric}`,
            format: isVideo ? defaultVideoFormat : 'jpeg',
            status: 'ready', // 'ready' | 'converting' | 'done' | 'error'
            statusText: 'Ready',
            progress: 0,
            downloadUrl: '',
            error: '',
          };
        } catch (err) {
          return {
            id,
            file: uploadedFile,
            name: uploadedFile.name,
            sizeMB: (uploadedFile.size / (1024 * 1024)).toFixed(2),
            isVideo: false,
            frameCount: 0,
            dimensions: 'Unknown',
            encodingInfo: 'Invalid DICOM',
            format: 'jpeg',
            status: 'error',
            statusText: 'Invalid DICOM file',
            progress: 0,
            downloadUrl: '',
            error: 'Could not parse DICOM header.',
          };
        }
      })
    );

    setQueue((prev) => [...prev, ...parsedItems]);
    e.target.value = '';
  };

  const updateItemFormat = (id, newFormat) => {
    setQueue((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              format: newFormat,
              status: item.status === 'done' ? 'ready' : item.status,
              statusText: item.status === 'done' ? 'Format changed — ready' : item.statusText,
              downloadUrl: '',
            }
          : item
      )
    );
  };

  const applyFormatToAllVideos = (fmt) => {
    setDefaultVideoFormat(fmt);
    setQueue((prev) =>
      prev.map((item) =>
        item.isVideo
          ? {
              ...item,
              format: fmt,
              status: item.status === 'done' ? 'ready' : item.status,
              statusText: item.status === 'done' ? 'Format changed — ready' : item.statusText,
              downloadUrl: '',
            }
          : item
      )
    );
  };

  const removeQueueItem = (id) => {
    setQueue((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target?.downloadUrl) URL.revokeObjectURL(target.downloadUrl);
      return prev.filter((i) => i.id !== id);
    });
  };

  const clearQueue = () => {
    queue.forEach((item) => {
      if (item.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
    });
    setQueue([]);
  };

  const loadFFmpeg = async () => {
    if (!ffmpegRef.current) {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      ffmpegRef.current = new FFmpeg();
    }
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg.loaded) {
      const { toBlobURL } = await import('@ffmpeg/util');
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
    }
    return ffmpeg;
  };

  // Convert a single queue item
  const convertSingleItem = async (item) => {
    const updatePatch = (patch) => {
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, ...patch } : q)));
    };

    updatePatch({ status: 'converting', statusText: 'Parsing pixels...', progress: 10, error: '' });

    try {
      const arrayBuffer = await item.file.arrayBuffer();
      const byteArray = new Uint8Array(arrayBuffer);
      const dataSet = dicomParser.parseDicom(byteArray);

      const rows = dataSet.uint16('x00280010');
      const cols = dataSet.uint16('x00280011');
      const samplesPerPixel = dataSet.uint16('x00280002') || 1;
      const photometric = (dataSet.string('x00280004') || 'MONOCHROME2').trim();
      const planarConfig = dataSet.uint16('x00280006') || 0;
      const bitsAllocated = dataSet.uint16('x00280100') || 8;
      const frameTime = dataSet.floatString('x00181063');
      const recommendedFps = dataSet.intString('x00082144');
      const fps = recommendedFps || (frameTime ? Math.round(1000 / frameTime) : 25);

      const pixelDataElement = dataSet.elements.x7fe00010;
      if (!pixelDataElement) {
        throw new Error('No pixel data (7FE0,0010) found.');
      }

      const isEncapsulated = Boolean(pixelDataElement.encapsulatedPixelData);

      const renderFrameToBlob = (frameIndex) => {
        return new Promise((resolve, reject) => {
          if (isEncapsulated) {
            try {
              const hasOffsetTable =
                pixelDataElement.basicOffsetTable &&
                pixelDataElement.basicOffsetTable.length > 0;

              const frameBytes = hasOffsetTable
                ? dicomParser.readEncapsulatedImageFrame(dataSet, pixelDataElement, frameIndex)
                : dicomParser.readEncapsulatedPixelDataFromFragments(
                    dataSet,
                    pixelDataElement,
                    frameIndex
                  );

              const rawBlob = new Blob([frameBytes], { type: 'image/jpeg' });
              const imgUrl = URL.createObjectURL(rawBlob);
              const img = new Image();
              img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width || cols;
                canvas.height = img.height || rows;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(imgUrl);
                canvas.toBlob((cleanBlob) => resolve(cleanBlob), 'image/jpeg', 0.95);
              };
              img.onerror = () => {
                URL.revokeObjectURL(imgUrl);
                reject(new Error('Unsupported DICOM compression codec (RLE / JPEG 2000).'));
              };
              img.src = imgUrl;
              return;
            } catch (encErr) {
              reject(new Error(`Frame ${frameIndex + 1} extraction failed: ${encErr.message}`));
              return;
            }
          }

          const bytesPerSample = bitsAllocated / 8;
          const pixelData = new Uint8Array(
            dataSet.byteArray.buffer,
            pixelDataElement.dataOffset,
            pixelDataElement.length
          );

          const canvas = document.createElement('canvas');
          canvas.width = cols;
          canvas.height = rows;
          const ctx = canvas.getContext('2d');
          const imgData = ctx.createImageData(cols, rows);
          const totalPixels = cols * rows;

          const ybrToRgb = (y, cb, cr) => {
            const r = Math.min(255, Math.max(0, Math.round(y + 1.402 * (cr - 128))));
            const g = Math.min(
              255,
              Math.max(0, Math.round(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)))
            );
            const b = Math.min(255, Math.max(0, Math.round(y + 1.772 * (cb - 128))));
            return [r, g, b];
          };

          if (photometric === 'YBR_FULL_422') {
            const frameByteOffset = frameIndex * totalPixels * 2;
            for (let i = 0; i < totalPixels; i += 2) {
              const idx = frameByteOffset + i * 2;
              const y0 = pixelData[idx] || 0;
              const cb = pixelData[idx + 1] || 128;
              const y1 = pixelData[idx + 2] || 0;
              const cr = pixelData[idx + 3] || 128;

              const [r0, g0, b0] = ybrToRgb(y0, cb, cr);
              const [r1, g1, b1] = ybrToRgb(y1, cb, cr);

              imgData.data[i * 4] = r0;
              imgData.data[i * 4 + 1] = g0;
              imgData.data[i * 4 + 2] = b0;
              imgData.data[i * 4 + 3] = 255;

              if (i + 1 < totalPixels) {
                imgData.data[(i + 1) * 4] = r1;
                imgData.data[(i + 1) * 4 + 1] = g1;
                imgData.data[(i + 1) * 4 + 2] = b1;
                imgData.data[(i + 1) * 4 + 3] = 255;
              }
            }
          } else if (samplesPerPixel === 3) {
            const frameByteOffset = frameIndex * totalPixels * 3 * bytesPerSample;
            const isYbr = photometric.startsWith('YBR');

            for (let i = 0; i < totalPixels; i++) {
              let c0, c1, c2;
              if (planarConfig === 0) {
                const idx = frameByteOffset + i * 3;
                c0 = pixelData[idx] || 0;
                c1 = pixelData[idx + 1] || 0;
                c2 = pixelData[idx + 2] || 0;
              } else {
                c0 = pixelData[frameByteOffset + i] || 0;
                c1 = pixelData[frameByteOffset + totalPixels + i] || 0;
                c2 = pixelData[frameByteOffset + totalPixels * 2 + i] || 0;
              }

              const [r, g, b] = isYbr ? ybrToRgb(c0, c1, c2) : [c0, c1, c2];
              imgData.data[i * 4] = r;
              imgData.data[i * 4 + 1] = g;
              imgData.data[i * 4 + 2] = b;
              imgData.data[i * 4 + 3] = 255;
            }
          } else {
            const frameByteOffset = frameIndex * totalPixels * bytesPerSample;
            let maxVal = 255;
            if (bytesPerSample === 2) {
              maxVal = 1;
              for (let i = 0; i < totalPixels; i++) {
                const low = pixelData[frameByteOffset + i * 2] || 0;
                const high = pixelData[frameByteOffset + i * 2 + 1] || 0;
                const v = (high << 8) | low;
                if (v > maxVal) maxVal = v;
              }
            }

            const invert = photometric === 'MONOCHROME1';
            for (let i = 0; i < totalPixels; i++) {
              let val = 0;
              if (bytesPerSample === 2) {
                const low = pixelData[frameByteOffset + i * 2] || 0;
                const high = pixelData[frameByteOffset + i * 2 + 1] || 0;
                const raw16 = (high << 8) | low;
                val = Math.round((raw16 / maxVal) * 255);
              } else {
                val = pixelData[frameByteOffset + i] || 0;
              }
              if (invert) val = 255 - val;

              imgData.data[i * 4] = val;
              imgData.data[i * 4 + 1] = val;
              imgData.data[i * 4 + 2] = val;
              imgData.data[i * 4 + 3] = 255;
            }
          }

          ctx.putImageData(imgData, 0, 0);
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.95);
        });
      };

      // Single-frame JPEG output
      if (!item.isVideo || item.format === 'jpeg') {
        updatePatch({ statusText: 'Rendering JPEG...', progress: 65 });
        const jpegBlob = await renderFrameToBlob(0);
        const url = URL.createObjectURL(jpegBlob);
        updatePatch({
          status: 'done',
          statusText: 'Converted to JPEG',
          progress: 100,
          downloadUrl: url,
        });
        return;
      }

      // Multi-frame Video output (MP4 / AVI / MPEG)
      updatePatch({ statusText: 'Loading encoder...', progress: 15 });
      const ffmpeg = await loadFFmpeg();

      for (let f = 0; f < item.frameCount; f++) {
        updatePatch({
          statusText: `Frame ${f + 1}/${item.frameCount}`,
          progress: 20 + Math.round(((f + 1) / item.frameCount) * 55),
        });
        const blob = await renderFrameToBlob(f);
        const buf = new Uint8Array(await blob.arrayBuffer());
        await ffmpeg.writeFile(`frame_${String(f).padStart(4, '0')}.jpg`, buf);
      }

      updatePatch({ statusText: `Encoding ${item.format.toUpperCase()}...`, progress: 82 });
      const outputName = `export_${item.id.replace(/[^a-zA-Z0-9]/g, '')}.${item.format}`;

      const ffmpegArgs =
        item.format === 'mp4'
          ? [
              '-framerate',
              String(fps),
              '-i',
              'frame_%04d.jpg',
              '-vf',
              'scale=trunc(iw/2)*2:trunc(ih/2)*2',
              '-c:v',
              'libx264',
              '-pix_fmt',
              'yuv420p',
              outputName,
            ]
          : [
              '-framerate',
              String(fps),
              '-i',
              'frame_%04d.jpg',
              '-vf',
              'scale=trunc(iw/2)*2:trunc(ih/2)*2',
              outputName,
            ];

      await ffmpeg.exec(ffmpegArgs);

      const data = await ffmpeg.readFile(outputName);
      const mimeMap = { mp4: 'video/mp4', avi: 'video/x-msvideo', mpeg: 'video/mpeg' };
      const videoBlob = new Blob([data.buffer], {
        type: mimeMap[item.format] || 'video/mp4',
      });

      // Clean up virtual FFmpeg files to save RAM during 10+ file batches
      for (let f = 0; f < item.frameCount; f++) {
        try {
          await ffmpeg.deleteFile(`frame_${String(f).padStart(4, '0')}.jpg`);
        } catch (_) {}
      }
      try {
        await ffmpeg.deleteFile(outputName);
      } catch (_) {}

      const url = URL.createObjectURL(videoBlob);
      updatePatch({
        status: 'done',
        statusText: `Converted to ${item.format.toUpperCase()} (${fps} FPS)`,
        progress: 100,
        downloadUrl: url,
      });
    } catch (err) {
      updatePatch({
        status: 'error',
        statusText: 'Conversion failed',
        progress: 0,
        error: err.message || 'Unknown error',
      });
    }
  };

  // Sequentially convert all ready files in the batch queue
  const handleConvertAll = async () => {
    if (isBatchProcessing) return;
    const pending = queue.filter((item) => item.status === 'ready');
    if (pending.length === 0) return;

    setIsBatchProcessing(true);
    for (const item of pending) {
      await convertSingleItem(item);
    }
    setIsBatchProcessing(false);
  };

  // Trigger sequential browser downloads for all completed files
  const handleDownloadAll = () => {
    const completed = queue.filter((item) => item.status === 'done' && item.downloadUrl);
    completed.forEach((item, index) => {
      setTimeout(() => {
        const cleanBase = item.name.replace(/\.[^/.]+$/, '');
        const a = document.createElement('a');
        a.href = item.downloadUrl;
        a.download = `${cleanBase}.${item.format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, index * 350);
    });
  };

  const readyCount = queue.filter((i) => i.status === 'ready').length;
  const doneCount = queue.filter((i) => i.status === 'done').length;

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#ffffff', color: '#0f172a', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      
      {/* Top Navbar */}
      <header style={{ position: 'sticky', top: 0, zIndex: 40, backgroundColor: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(8px)', borderBottom: '1px solid #f1f5f9', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '21px', fontWeight: '800', letterSpacing: '-0.02em', color: '#0f172a' }}>
          Cardio<span style={{ color: '#0284c7' }}>DICOM</span>
        </div>

        <button
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          style={{ background: 'none', border: 'none', fontSize: '24px', color: '#334155', cursor: 'pointer', padding: '4px 8px' }}
        >
          ☰
        </button>
      </header>

      {/* Slide-out Mobile Drawer */}
      {menuOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.45)', backdropFilter: 'blur(3px)' }} onClick={() => setMenuOpen(false)}>
          <div style={{ width: '78%', maxWidth: '320px', backgroundColor: '#ffffff', height: '100%', padding: '24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', boxShadow: '-10px 0 30px rgba(0,0,0,0.15)' }} onClick={(e) => e.stopPropagation()}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
                <span style={{ fontSize: '20px', fontWeight: '800', color: '#0f172a' }}>
                  Cardio<span style={{ color: '#0284c7' }}>DICOM</span>
                </span>
                <button onClick={() => setMenuOpen(false)} style={{ background: 'none', border: 'none', fontSize: '22px', color: '#64748b', cursor: 'pointer' }}>✕</button>
              </div>

              <nav style={{ display: 'flex', flexDirection: 'column', gap: '20px', fontSize: '16px', fontWeight: '500', color: '#475569' }}>
                <a href="#converter" onClick={scrollToConverter} style={{ textDecoration: 'none', color: 'inherit' }}>Batch Converter</a>
                <a href="#how-it-works" onClick={() => setMenuOpen(false)} style={{ textDecoration: 'none', color: 'inherit' }}>How it works</a>
                <a href="#security" onClick={() => setMenuOpen(false)} style={{ textDecoration: 'none', color: 'inherit' }}>HIPAA &amp; Privacy</a>
              </nav>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={() => { setMenuOpen(false); setAuthNotice(''); setAuthModal('signin'); }}
                style={{ width: '100%', padding: '12px', borderRadius: '10px', border: '1px solid #cbd5e1', backgroundColor: '#ffffff', color: '#0f172a', fontWeight: '600', fontSize: '15px', cursor: 'pointer' }}
              >
                Sign in
              </button>
              <button
                onClick={() => { setMenuOpen(false); setAuthNotice(''); setAuthModal('signup'); }}
                style={{ width: '100%', padding: '12px', borderRadius: '10px', border: 'none', backgroundColor: '#0284c7', color: '#ffffff', fontWeight: '600', fontSize: '15px', cursor: 'pointer' }}
              >
                Start free →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2-Column Hero Section with Right-Side Cardio Visual Banners */}
      <section style={{ maxWidth: '1120px', margin: '0 auto', padding: '44px 24px 36px 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '36px', alignItems: 'center' }}>
        
        {/* Left Column: Headline & CTA */}
        <div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', backgroundColor: '#f0f9ff', border: '1px solid #bae6fd', color: '#0369a1', padding: '6px 14px', borderRadius: '999px', fontSize: '13px', fontWeight: '600', marginBottom: '22px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#0284c7' }} />
            New · Batch Echo Cine Loop &amp; Still Export
          </div>

          <h1 style={{ fontSize: '42px', lineHeight: '1.13', fontWeight: '800', letterSpacing: '-0.03em', color: '#0f172a', margin: '0 0 18px 0' }}>
            Convert cardiac DICOM files in <span style={{ color: '#0284c7' }}>one place</span>
          </h1>

          <p style={{ fontSize: '17px', lineHeight: '1.6', color: '#475569', margin: '0 0 28px 0' }}>
            Upload single or multiple echocardiography cine loops and still scans at once. CardioDICOM converts videos into MP4, AVI, or MPEG and images into high-resolution JPEG — 100% locally in your browser.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '340px' }}>
            <button
              onClick={scrollToConverter}
              style={{ width: '100%', padding: '14px 20px', borderRadius: '10px', border: 'none', backgroundColor: '#0284c7', color: '#ffffff', fontWeight: '700', fontSize: '16px', cursor: 'pointer', boxShadow: '0 4px 14px rgba(2, 132, 199, 0.25)' }}
            >
              Start converting free →
            </button>
            <button
              onClick={() => { setAuthNotice(''); setAuthModal('signin'); }}
              style={{ width: '100%', padding: '13px 20px', borderRadius: '10px', border: '1px solid #cbd5e1', backgroundColor: '#ffffff', color: '#0f172a', fontWeight: '600', fontSize: '15px', cursor: 'pointer' }}
            >
              Sign in to workspace
            </button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', marginTop: '22px', fontSize: '13px', color: '#64748b', fontWeight: '500' }}>
            <span><strong style={{ color: '#10b981' }}>✓</strong> Batch multi-file upload</span>
            <span><strong style={{ color: '#10b981' }}>✓</strong> 100% browser-based</span>
            <span><strong style={{ color: '#10b981' }}>✓</strong> Zero server uploads</span>
          </div>
        </div>

        {/* Right Column: Cardio Echo & Visual Engine Banners */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          
          {/* Card 1: Echo Scan Preview */}
          <div style={{ background: 'linear-gradient(135deg, #0b162c 0%, #13294b 100%)', borderRadius: '16px', padding: '18px 20px', color: '#ffffff', boxShadow: '0 14px 30px -8px rgba(15, 23, 42, 0.25)', border: '1px solid #1e3a5f' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '11px', fontWeight: '800', letterSpacing: '0.08em', color: '#7dd3fc' }}>ECHO SCAN PREVIEW</span>
              <span style={{ fontSize: '11px', backgroundColor: 'rgba(14, 165, 233, 0.2)', color: '#38bdf8', padding: '2px 8px', borderRadius: '999px', fontWeight: '600' }}>4-CHAMBER CINE</span>
            </div>
            <svg viewBox="0 0 360 120" style={{ width: '100%', height: 'auto', display: 'block', borderRadius: '10px', backgroundColor: '#060d1a' }}>
              {/* Ultrasound Sector Cone */}
              <path d="M180 12 L75 104 A145 145 0 0 0 285 104 Z" fill="url(#sectorGrad)" stroke="#1e3a5f" strokeWidth="1" />
              <defs>
                <radialGradient id="sectorGrad" cx="50%" cy="10%" r="85%">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
                  <stop offset="65%" stopColor="#0284c7" stopOpacity="0.18" />
                  <stop offset="100%" stopColor="#060d1a" stopOpacity="0.9" />
                </radialGradient>
              </defs>
              {/* Stylized Cardiac Chambers */}
              <ellipse cx="165" cy="64" rx="22" ry="30" transform="rotate(-14 165 64)" fill="none" stroke="#7dd3fc" strokeWidth="2.5" opacity="0.85" />
              <ellipse cx="202" cy="66" rx="17" ry="26" transform="rotate(14 202 66)" fill="none" stroke="#38bdf8" strokeWidth="2" opacity="0.7" />
              {/* Live ECG Rhythm Strip at bottom */}
              <polyline
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
                points="16,108 65,108 74,102 82,108 90,108 95,84 101,115 107,96 115,108 165,108 174,102 182,108 190,108 195,84 201,115 207,96 215,108 265,108 274,102 282,108 290,108 295,84 301,115 307,96 315,108 345,108"
              />
            </svg>
          </div>

          {/* Card 2: Cardiovisual Engine */}
          <div style={{ background: 'linear-gradient(135deg, #090d16 0%, #172033 100%)', borderRadius: '16px', padding: '18px 20px', color: '#ffffff', boxShadow: '0 14px 30px -8px rgba(15, 23, 42, 0.25)', border: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
            <div>
              <div style={{ fontSize: '11px', fontWeight: '800', letterSpacing: '0.08em', color: '#38bdf8', marginBottom: '6px' }}>
                CARDIOVISUAL ENGINE
              </div>
              <div style={{ fontSize: '15px', fontWeight: '700', color: '#f8fafc', marginBottom: '4px' }}>
                Multi-File DICOM Batch Queue
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', lineHeight: '1.5' }}>
                Auto-detects cine frames vs. still scans and exports each file in its native format.
              </div>
            </div>
            <div style={{ width: '56px', height: '56px', borderRadius: '14px', background: 'linear-gradient(135deg, rgba(14,165,233,0.2), rgba(244,63,94,0.2))', border: '1px solid rgba(56,189,248,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px', flexShrink: 0 }}>
              🫀
            </div>
          </div>

        </div>
      </section>

      {/* Interactive Batch Converter Section */}
      <section ref={converterSectionRef} id="converter" style={{ maxWidth: '760px', margin: '0 auto', padding: '12px 20px 64px 20px' }}>
        <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '18px', padding: '24px', boxShadow: '0 10px 25px -5px rgba(15, 23, 42, 0.06)' }}>
          
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '19px', fontWeight: '800', margin: 0, color: '#0f172a' }}>
                Cardio DICOM Batch Converter
              </h2>
              <p style={{ fontSize: '12px', color: '#64748b', margin: '2px 0 0 0' }}>
                Select 1 or multiple DICOM files — each converts to its own format
              </p>
            </div>
            <span style={{ fontSize: '11px', fontWeight: '700', backgroundColor: '#e0f2fe', color: '#0369a1', padding: '4px 10px', borderRadius: '999px' }}>
              LOCAL BATCH ENGINE
            </span>
          </div>

          {/* Multi-File Upload Zone */}
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: '2px dashed #94a3b8', borderRadius: '14px', padding: '28px 16px', backgroundColor: '#ffffff', cursor: 'pointer', textAlign: 'center' }}>
            <span style={{ fontSize: '30px', marginBottom: '8px' }}>📂</span>
            <span style={{ fontSize: '15px', fontWeight: '700', color: '#0f172a' }}>
              {queue.length > 0 ? 'Tap to Add More DICOM Files' : 'Tap to Upload Single or Multiple DICOM Files'}
            </span>
            <span style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Hold Ctrl / Cmd or drag-select multiple files • Videos → MP4, AVI, MPEG | Images → JPEG
            </span>
            <input
              type="file"
              multiple
              onChange={handleFilesUpload}
              style={{ display: 'none' }}
            />
          </label>

          {/* Batch Controls Bar (Visible when files are queued) */}
          {queue.length > 0 && (
            <div style={{ marginTop: '18px', padding: '12px 14px', backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#0f172a' }}>
                {queue.length} {queue.length === 1 ? 'File' : 'Files'} Queued ({doneCount} converted)
              </div>

              {/* Global Video Format Switcher if any videos exist */}
              {queue.some((i) => i.isVideo) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                  <span style={{ color: '#64748b', fontWeight: '600' }}>All Videos:</span>
                  {['mp4', 'avi', 'mpeg'].map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => applyFormatToAllVideos(fmt)}
                      style={{
                        padding: '4px 9px',
                        borderRadius: '6px',
                        border: defaultVideoFormat === fmt ? '1.5px solid #0284c7' : '1px solid #cbd5e1',
                        backgroundColor: defaultVideoFormat === fmt ? '#e0f2fe' : '#f8fafc',
                        color: defaultVideoFormat === fmt ? '#0369a1' : '#475569',
                        fontWeight: '700',
                        fontSize: '11px',
                        cursor: 'pointer',
                        textTransform: 'uppercase',
                      }}
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={clearQueue}
                disabled={isBatchProcessing}
                style={{ background: 'none', border: 'none', color: '#dc2626', fontSize: '12px', fontWeight: '600', cursor: isBatchProcessing ? 'not-allowed' : 'pointer' }}
              >
                Clear all
              </button>
            </div>
          )}

          {/* Individual File Cards List */}
          {queue.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '14px' }}>
              {queue.map((item) => {
                const cleanBase = item.name.replace(/\.[^/.]+$/, '');
                return (
                  <div
                    key={item.id}
                    style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px 16px' }}
                  >
                    {/* Top Row: Filename, Metadata & Individual Format Selector */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                      <div style={{ minWidth: '180px', flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '16px' }}>{item.isVideo ? '🎬' : '🖼️'}</span>
                          <span style={{ fontSize: '14px', fontWeight: '700', color: '#0f172a', wordBreak: 'break-all' }}>
                            {item.name}
                          </span>
                        </div>
                        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '3px' }}>
                          {item.sizeMB} MB • {item.dimensions} •{' '}
                          <strong style={{ color: item.isVideo ? '#0284c7' : '#059669' }}>
                            {item.isVideo ? `Video (${item.frameCount} frames)` : 'Still Image (1 frame)'}
                          </strong>
                        </div>
                      </div>

                      {/* Per-file Output Format Selector & Remove Button */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {item.status !== 'error' && (
                          <select
                            value={item.format}
                            disabled={isBatchProcessing}
                            onChange={(e) => updateItemFormat(item.id, e.target.value)}
                            style={{
                              padding: '6px 10px',
                              borderRadius: '8px',
                              border: '1px solid #cbd5e1',
                              backgroundColor: '#f8fafc',
                              color: '#0f172a',
                              fontWeight: '700',
                              fontSize: '12px',
                              textTransform: 'uppercase',
                              cursor: 'pointer',
                            }}
                          >
                            {item.isVideo ? (
                              <>
                                <option value="mp4">MP4</option>
                                <option value="avi">AVI</option>
                                <option value="mpeg">MPEG</option>
                              </>
                            ) : (
                              <option value="jpeg">JPEG</option>
                            )}
                          </select>
                        )}

                        {item.status === 'done' && item.downloadUrl && (
                          <a
                            href={item.downloadUrl}
                            download={`${cleanBase}.${item.format}`}
                            style={{
                              padding: '7px 14px',
                              borderRadius: '8px',
                              backgroundColor: '#059669',
                              color: '#ffffff',
                              fontWeight: '700',
                              fontSize: '12px',
                              textDecoration: 'none',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Download .{item.format.toUpperCase()}
                          </a>
                        )}

                        <button
                          type="button"
                          onClick={() => removeQueueItem(item.id)}
                          disabled={isBatchProcessing && item.status === 'converting'}
                          title="Remove file"
                          style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '16px', cursor: 'pointer', padding: '4px' }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    {/* Progress Bar & Status Line */}
                    <div style={{ marginTop: '10px' }}>
                      {item.status === 'converting' && (
                        <div style={{ width: '100%', height: '5px', backgroundColor: '#e2e8f0', borderRadius: '999px', overflow: 'hidden', marginBottom: '6px' }}>
                          <div style={{ width: `${item.progress}%`, height: '100%', backgroundColor: '#0284c7', transition: 'width 0.25s ease' }} />
                        </div>
                      )}
                      <div style={{ fontSize: '12px', color: item.status === 'error' ? '#dc2626' : item.status === 'done' ? '#059669' : '#64748b', fontWeight: '500' }}>
                        {item.error ? `Error: ${item.error}` : item.statusText}
                      </div>
                    </div>

                    {/* Inline Media Preview after Conversion */}
                    {item.status === 'done' && item.downloadUrl && (
                      <div style={{ marginTop: '10px' }}>
                        {item.isVideo && item.format === 'mp4' ? (
                          <video
                            src={item.downloadUrl}
                            controls
                            loop
                            muted
                            playsInline
                            style={{ width: '100%', maxHeight: '240px', borderRadius: '8px', backgroundColor: '#000000' }}
                          />
                        ) : !item.isVideo ? (
                          <img
                            src={item.downloadUrl}
                            alt={item.name}
                            style={{ maxWidth: '100%', maxHeight: '220px', borderRadius: '8px', border: '1px solid #e2e8f0' }}
                          />
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Bottom Batch Action Buttons */}
          {queue.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '18px' }}>
              {readyCount > 0 && (
                <button
                  type="button"
                  onClick={handleConvertAll}
                  disabled={isBatchProcessing}
                  style={{
                    flex: 1,
                    minWidth: '200px',
                    padding: '14px',
                    borderRadius: '10px',
                    border: 'none',
                    backgroundColor: isBatchProcessing ? '#94a3b8' : '#0284c7',
                    color: '#ffffff',
                    fontWeight: '700',
                    fontSize: '15px',
                    cursor: isBatchProcessing ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isBatchProcessing
                    ? 'Converting Batch...'
                    : `Convert ${readyCount} ${readyCount === 1 ? 'File' : 'Files'}`}
                </button>
              )}

              {doneCount > 1 && (
                <button
                  type="button"
                  onClick={handleDownloadAll}
                  style={{
                    flex: 1,
                    minWidth: '200px',
                    padding: '14px',
                    borderRadius: '10px',
                    border: 'none',
                    backgroundColor: '#059669',
                    color: '#ffffff',
                    fontWeight: '700',
                    fontSize: '15px',
                    cursor: 'pointer',
                  }}
                >
                  Download All ({doneCount} Files)
                </button>
              )}
            </div>
          )}

        </div>
      </section>

      {/* How It Works Section */}
      <section id="how-it-works" style={{ backgroundColor: '#f8fafc', borderTop: '1px solid #f1f5f9', padding: '48px 20px' }}>
        <div style={{ maxWidth: '760px', margin: '0 auto' }}>
          <h2 style={{ fontSize: '24px', fontWeight: '800', margin: '0 0 24px 0', color: '#0f172a' }}>How it works</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
            <div style={{ backgroundColor: '#ffffff', padding: '20px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: '800', color: '#0284c7', marginBottom: '6px' }}>1. Batch Upload</div>
              <p style={{ fontSize: '14px', color: '#475569', margin: 0 }}>Select 1 or 10+ DICOM videos and still images together in one step.</p>
            </div>
            <div style={{ backgroundColor: '#ffffff', padding: '20px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: '800', color: '#0284c7', marginBottom: '6px' }}>2. Auto Format Mapping</div>
              <p style={{ fontSize: '14px', color: '#475569', margin: 0 }}>Cine loops map to MP4/AVI/MPEG and still frames map to JPEG automatically.</p>
            </div>
            <div style={{ backgroundColor: '#ffffff', padding: '20px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: '800', color: '#0284c7', marginBottom: '6px' }}>3. Individual or All Export</div>
              <p style={{ fontSize: '14px', color: '#475569', margin: 0 }}>Preview each file inline and download individually or all at once.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Dark SaaS Footer */}
      <footer id="security" style={{ backgroundColor: '#090d16', color: '#94a3b8', padding: '48px 24px 36px 24px' }}>
        <div style={{ maxWidth: '760px', margin: '0 auto' }}>
          <div style={{ fontSize: '22px', fontWeight: '800', color: '#38bdf8', marginBottom: '12px' }}>
            Cardio<span style={{ color: '#ffffff' }}>DICOM</span>
          </div>
          <p style={{ fontSize: '14px', lineHeight: '1.6', maxWidth: '460px', margin: '0 0 32px 0' }}>
            The browser-native platform that helps clinicians, researchers, and imaging labs convert cardiac DICOM files safely — all in one place.
          </p>
          <div style={{ borderTop: '1px solid #1e293b', paddingTop: '24px', textAlign: 'center', fontSize: '13px', color: '#64748b' }}>
            © 2026 CardioDICOM. All rights reserved.
          </div>
        </div>
      </footer>

      {/* Sign In / Sign Up Modal */}
      {authModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, backgroundColor: 'rgba(15, 23, 42, 0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setAuthModal(null)}>
          <div style={{ width: '100%', maxWidth: '380px', backgroundColor: '#ffffff', borderRadius: '16px', padding: '24px', boxShadow: '0 20px 40px rgba(0,0,0,0.25)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '19px', fontWeight: '800', margin: 0, color: '#0f172a' }}>
                {authModal === 'signin' ? 'Sign in to CardioDICOM' : 'Create free account'}
              </h3>
              <button onClick={() => setAuthModal(null)} style={{ background: 'none', border: 'none', fontSize: '20px', color: '#64748b', cursor: 'pointer' }}>✕</button>
            </div>

            <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: '#334155', marginBottom: '4px' }}>Email address</label>
                <input
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="doctor@hospital.org"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: '#334155', marginBottom: '4px' }}>Password</label>
                <input
                  type="password"
                  required
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="••••••••"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              <button
                type="submit"
                style={{ width: '100%', padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: '#0284c7', color: '#ffffff', fontWeight: '700', fontSize: '15px', cursor: 'pointer', marginTop: '4px' }}
              >
                {authModal === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </form>

            {authNotice && (
              <p style={{ marginTop: '12px', padding: '10px', borderRadius: '8px', backgroundColor: '#f0f9ff', color: '#0369a1', fontSize: '12px', textAlign: 'center' }}>
                {authNotice}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

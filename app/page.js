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

  // DICOM Converter State
  const [file, setFile] = useState(null);
  const [isVideo, setIsVideo] = useState(false);
  const [frameCount, setFrameCount] = useState(1);
  const [dimensions, setDimensions] = useState('');
  const [encodingInfo, setEncodingInfo] = useState('');
  const [selectedFormat, setSelectedFormat] = useState('');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const ffmpegRef = useRef(null);
  const converterSectionRef = useRef(null);

  const scrollToConverter = () => {
    setMenuOpen(false);
    converterSectionRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleAuthSubmit = (e) => {
    e.preventDefault();
    setAuthNotice('Sign-in UI is ready. You can currently use the converter freely without an account.');
  };

  // DICOM Upload & Analysis
  const handleFileUpload = async (e) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;

    setFile(uploadedFile);
    setDownloadUrl('');
    setErrorMsg('');
    setProgress(0);
    setStatus('Reading DICOM header...');

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

      setFrameCount(frames);
      setDimensions(`${cols} × ${rows} px`);
      setEncodingInfo(`${isEncapsulated ? 'Compressed JPEG' : 'Raw'} • ${photometric}`);

      if (frames > 1) {
        setIsVideo(true);
        setSelectedFormat('mp4');
        setStatus('Ready to convert multi-frame DICOM cine loop.');
      } else {
        setIsVideo(false);
        setSelectedFormat('jpeg');
        setStatus('Ready to convert single-frame DICOM image.');
      }
    } catch (err) {
      setFile(null);
      setStatus('');
      setErrorMsg('Invalid DICOM file. Please upload a valid .dcm file.');
    }
  };

  const loadFFmpeg = async () => {
    if (!ffmpegRef.current) {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      ffmpegRef.current = new FFmpeg();
    }
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg.loaded) {
      setStatus('Initializing browser video encoder...');
      const { toBlobURL } = await import('@ffmpeg/util');
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
    }
    return ffmpeg;
  };

  const handleConvert = async () => {
    if (!file || !selectedFormat || isProcessing) return;

    setIsProcessing(true);
    setDownloadUrl('');
    setErrorMsg('');
    setProgress(5);

    try {
      const arrayBuffer = await file.arrayBuffer();
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
        throw new Error('No pixel data tag (7FE0,0010) found in this DICOM file.');
      }

      const isEncapsulated = Boolean(pixelDataElement.encapsulatedPixelData);

      // Extract a single frame as a JPEG Blob (supports both Encapsulated JPEG and Raw Pixels)
      const renderFrameToBlob = (frameIndex) => {
        return new Promise((resolve, reject) => {
          // CASE 1: Encapsulated / Compressed Echo Cine Loop (JPEG Baseline / Lossless)
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

              // Re-draw through canvas to guarantee clean baseline JPEG dimensions for FFmpeg
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
                reject(
                  new Error(
                    'Unsupported DICOM compression codec (e.g., RLE or JPEG 2000). Export as Uncompressed or JPEG Baseline from your echo machine.'
                  )
                );
              };
              img.src = imgUrl;
              return;
            } catch (encErr) {
              reject(new Error(`Failed to extract compressed frame ${frameIndex + 1}: ${encErr.message}`));
              return;
            }
          }

          // CASE 2: Uncompressed Raw Pixel Data (RGB, YBR_FULL_422, or Grayscale)
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
            // 2 bytes per pixel: [Y0, Cb, Y1, Cr]
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
            // Grayscale (8-bit or 16-bit with auto-range scaling)
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

      // Single Image -> JPEG
      if (!isVideo && selectedFormat === 'jpeg') {
        setStatus('Rendering high-resolution JPEG...');
        setProgress(60);
        const jpegBlob = await renderFrameToBlob(0);
        setDownloadUrl(URL.createObjectURL(jpegBlob));
        setProgress(100);
        setStatus('JPEG image ready for download.');
        setIsProcessing(false);
        return;
      }

      // Multi-frame Cine Loop -> MP4 / AVI / MPEG
      if (isVideo) {
        const ffmpeg = await loadFFmpeg();
        setProgress(20);

        for (let f = 0; f < frameCount; f++) {
          setStatus(`Extracting frame ${f + 1} of ${frameCount}...`);
          const blob = await renderFrameToBlob(f);
          const buf = new Uint8Array(await blob.arrayBuffer());
          await ffmpeg.writeFile(`frame_${String(f).padStart(4, '0')}.jpg`, buf);
          setProgress(20 + Math.round(((f + 1) / frameCount) * 50));
        }

        setStatus(`Encoding ${selectedFormat.toUpperCase()} video (${fps} FPS)...`);
        setProgress(80);
        const outputName = `cardio_export.${selectedFormat}`;

        // Ensure even dimensions (libx264 requires width/height divisible by 2)
        const ffmpegArgs =
          selectedFormat === 'mp4'
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
          type: mimeMap[selectedFormat] || 'video/mp4',
        });

        setDownloadUrl(URL.createObjectURL(videoBlob));
        setProgress(100);
        setStatus(`${selectedFormat.toUpperCase()} video ready for download.`);
      }
    } catch (err) {
      setErrorMsg(err.message || 'Conversion failed.');
      setStatus('');
    } finally {
      setIsProcessing(false);
    }
  };

  const baseFileName = file ? file.name.replace(/\.[^/.]+$/, '') : 'cardio-dicom';

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#ffffff', color: '#0f172a', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      
      {/* Top Navbar */}
      <header style={{ position: 'sticky', top: 0, zIndex: 40, backgroundColor: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(8px)', borderBottom: '1px solid #f1f5f9', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '20px', fontWeight: '800', letterSpacing: '-0.02em', color: '#0f172a' }}>
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
                <a href="#converter" onClick={scrollToConverter} style={{ textDecoration: 'none', color: 'inherit' }}>Converter Tool</a>
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

      {/* Hero Section */}
      <section style={{ maxWidth: '720px', margin: '0 auto', padding: '44px 20px 32px 20px' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', backgroundColor: '#f0f9ff', border: '1px solid #bae6fd', color: '#0369a1', padding: '6px 14px', borderRadius: '999px', fontSize: '13px', fontWeight: '600', marginBottom: '22px' }}>
          <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#0284c7' }} />
          New · Echo Cine Loop &amp; Still Export
        </div>

        <h1 style={{ fontSize: '38px', lineHeight: '1.15', fontWeight: '800', letterSpacing: '-0.03em', color: '#0f172a', margin: '0 0 18px 0' }}>
          Convert cardiac DICOM files in <span style={{ color: '#0284c7' }}>one place</span>
        </h1>

        <p style={{ fontSize: '17px', lineHeight: '1.6', color: '#475569', margin: '0 0 28px 0' }}>
          CardioDICOM transforms echocardiography cine loops into MP4, AVI, or MPEG videos and exports still DICOM frames as high-resolution JPEG images — right inside your browser.
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
          <span><strong style={{ color: '#10b981' }}>✓</strong> No sign-up required</span>
          <span><strong style={{ color: '#10b981' }}>✓</strong> 100% browser-based</span>
          <span><strong style={{ color: '#10b981' }}>✓</strong> Zero server uploads</span>
        </div>
      </section>

      {/* Interactive Converter Tool Section */}
      <section ref={converterSectionRef} id="converter" style={{ maxWidth: '540px', margin: '0 auto', padding: '16px 20px 56px 20px' }}>
        <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '18px', padding: '24px', boxShadow: '0 10px 25px -5px rgba(15, 23, 42, 0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: '700', margin: 0, color: '#0f172a' }}>
              Cardio DICOM Converter
            </h2>
            <span style={{ fontSize: '11px', fontWeight: '700', backgroundColor: '#e0f2fe', color: '#0369a1', padding: '4px 10px', borderRadius: '999px' }}>
              LOCAL ENGINE
            </span>
          </div>

          {/* Upload Zone */}
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: '2px dashed #94a3b8', borderRadius: '14px', padding: '28px 16px', backgroundColor: '#ffffff', cursor: 'pointer', textAlign: 'center' }}>
            <span style={{ fontSize: '30px', marginBottom: '8px' }}>🫀</span>
            <span style={{ fontSize: '15px', fontWeight: '600', color: '#0f172a' }}>
              {file ? file.name : 'Tap to Upload DICOM Video or Image (.dcm)'}
            </span>
            <span style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              {file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB • ${dimensions} • ${encodingInfo}` : 'Videos → MP4, AVI, MPEG  |  Images → JPEG'}
            </span>
            <input
              type="file"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
          </label>

          {/* Detected Media Info */}
          {file && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#ffffff', border: '1px solid #e2e8f0', padding: '10px 14px', borderRadius: '10px', marginTop: '14px', fontSize: '13px' }}>
              <span style={{ color: '#64748b' }}>Detected DICOM Type:</span>
              <span style={{ fontWeight: '700', color: isVideo ? '#0284c7' : '#059669' }}>
                {isVideo ? `Cine Video (${frameCount} frames)` : 'Single Image (1 frame)'}
              </span>
            </div>
          )}

          {/* Format Selector */}
          {file && (
            <div style={{ marginTop: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: '#334155', marginBottom: '8px' }}>
                Which format do you want to download?
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: isVideo ? 'repeat(3, 1fr)' : '1fr', gap: '8px' }}>
                {(isVideo ? ['mp4', 'avi', 'mpeg'] : ['jpeg']).map((fmt) => {
                  const active = selectedFormat === fmt;
                  return (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => {
                        setSelectedFormat(fmt);
                        setDownloadUrl('');
                      }}
                      style={{
                        padding: '11px',
                        borderRadius: '10px',
                        border: active ? '2px solid #0284c7' : '1px solid #cbd5e1',
                        backgroundColor: active ? '#e0f2fe' : '#ffffff',
                        color: active ? '#0369a1' : '#475569',
                        fontWeight: '700',
                        fontSize: '13px',
                        cursor: 'pointer',
                        textTransform: 'uppercase',
                      }}
                    >
                      .{fmt}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Convert Button */}
          {file && (
            <button
              type="button"
              onClick={handleConvert}
              disabled={isProcessing}
              style={{
                width: '100%',
                marginTop: '18px',
                padding: '14px',
                borderRadius: '10px',
                border: 'none',
                backgroundColor: isProcessing ? '#94a3b8' : '#0284c7',
                color: '#ffffff',
                fontWeight: '700',
                fontSize: '15px',
                cursor: isProcessing ? 'not-allowed' : 'pointer',
              }}
            >
              {isProcessing ? 'Converting...' : `Convert to ${selectedFormat.toUpperCase()}`}
            </button>
          )}

          {/* Progress & Status */}
          {(isProcessing || status) && (
            <div style={{ marginTop: '14px' }}>
              {isProcessing && (
                <div style={{ width: '100%', height: '6px', backgroundColor: '#e2e8f0', borderRadius: '999px', overflow: 'hidden', marginBottom: '8px' }}>
                  <div style={{ width: `${progress}%`, height: '100%', backgroundColor: '#0284c7', transition: 'width 0.3s ease' }} />
                </div>
              )}
              <p style={{ fontSize: '13px', textAlign: 'center', color: '#475569', margin: 0 }}>
                {status}
              </p>
            </div>
          )}

          {/* Error Box */}
          {errorMsg && (
            <div style={{ marginTop: '14px', padding: '12px', borderRadius: '10px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: '13px', textAlign: 'center' }}>
              {errorMsg}
            </div>
          )}

          {/* Live Video / Image Preview & Download Button */}
          {downloadUrl && (
            <div style={{ marginTop: '18px', paddingTop: '16px', borderTop: '1px solid #e2e8f0' }}>
              {isVideo && selectedFormat === 'mp4' ? (
                <video
                  src={downloadUrl}
                  controls
                  autoPlay
                  loop
                  muted
                  playsInline
                  style={{ width: '100%', borderRadius: '10px', marginBottom: '12px', border: '1px solid #cbd5e1', backgroundColor: '#000000' }}
                />
              ) : !isVideo ? (
                <img
                  src={downloadUrl}
                  alt="Converted DICOM preview"
                  style={{ width: '100%', borderRadius: '10px', marginBottom: '12px', border: '1px solid #cbd5e1' }}
                />
              ) : null}

              <a
                href={downloadUrl}
                download={`${baseFileName}.${selectedFormat}`}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'center',
                  padding: '14px',
                  borderRadius: '10px',
                  backgroundColor: '#059669',
                  color: '#ffffff',
                  fontWeight: '700',
                  fontSize: '15px',
                  textDecoration: 'none',
                  boxSizing: 'border-box',
                }}
              >
                Download {selectedFormat.toUpperCase()} File
              </a>
            </div>
          )}
        </div>
      </section>

      {/* How It Works Section */}
      <section id="how-it-works" style={{ backgroundColor: '#f8fafc', borderTop: '1px solid #f1f5f9', padding: '48px 20px' }}>
        <div style={{ maxWidth: '720px', margin: '0 auto' }}>
          <h2 style={{ fontSize: '24px', fontWeight: '800', margin: '0 0 24px 0', color: '#0f172a' }}>How it works</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
            <div style={{ backgroundColor: '#ffffff', padding: '20px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: '800', color: '#0284c7', marginBottom: '6px' }}>1. Upload DICOM</div>
              <p style={{ fontSize: '14px', color: '#475569', margin: 0 }}>Select any single-frame DICOM scan or multi-frame echocardiogram loop.</p>
            </div>
            <div style={{ backgroundColor: '#ffffff', padding: '20px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: '800', color: '#0284c7', marginBottom: '6px' }}>2. Pick Format</div>
              <p style={{ fontSize: '14px', color: '#475569', margin: 0 }}>Choose MP4, AVI, or MPEG for cine loops, or JPEG for still images.</p>
            </div>
            <div style={{ backgroundColor: '#ffffff', padding: '20px', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: '800', color: '#0284c7', marginBottom: '6px' }}>3. Instant Download</div>
              <p style={{ fontSize: '14px', color: '#475569', margin: 0 }}>Files process locally on your device and download immediately.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Dark SaaS Footer */}
      <footer id="security" style={{ backgroundColor: '#090d16', color: '#94a3b8', padding: '48px 24px 36px 24px' }}>
        <div style={{ maxWidth: '720px', margin: '0 auto' }}>
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

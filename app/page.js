'use client';

import { useState, useRef } from 'react';
import dicomParser from 'dicom-parser';

export default function CardioDicomConverter() {
  const [file, setFile] = useState(null);
  const [isVideo, setIsVideo] = useState(false);
  const [frameCount, setFrameCount] = useState(1);
  const [dimensions, setDimensions] = useState('');
  const [selectedFormat, setSelectedFormat] = useState('');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const ffmpegRef = useRef(null);

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

      setFrameCount(frames);
      setDimensions(`${cols} × ${rows} px`);

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
      setErrorMsg('Invalid DICOM file. Please upload a valid uncompressed .dcm file.');
    }
  };

  const loadFFmpeg = async () => {
    if (!ffmpegRef.current) {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      ffmpegRef.current = new FFmpeg();
    }
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg.loaded) {
      setStatus('Initializing video encoder...');
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
      const planarConfig = dataSet.uint16('x00280006') || 0;
      const bitsAllocated = dataSet.uint16('x00280100') || 8;
      const frameTime = dataSet.floatString('x00181063');
      const recommendedFps = dataSet.intString('x00082144');
      const fps = recommendedFps || (frameTime ? Math.round(1000 / frameTime) : 25);

      const pixelDataElement = dataSet.elements.x7fe00010;
      if (!pixelDataElement) {
        throw new Error('No raw pixel data found (file may use compressed transfer syntax).');
      }

      const bytesPerSample = bitsAllocated / 8;
      const pixelData = new Uint8Array(
        dataSet.byteArray.buffer,
        pixelDataElement.dataOffset,
        pixelDataElement.length
      );

      const renderFrameToBlob = (frameIndex) => {
        return new Promise((resolve) => {
          const canvas = document.createElement('canvas');
          canvas.width = cols;
          canvas.height = rows;
          const ctx = canvas.getContext('2d');
          const imgData = ctx.createImageData(cols, rows);
          const totalPixels = cols * rows;
          const frameByteOffset = frameIndex * totalPixels * samplesPerPixel * bytesPerSample;

          if (samplesPerPixel === 3) {
            // Color Doppler / RGB Ultrasound
            if (planarConfig === 0) {
              for (let i = 0; i < totalPixels; i++) {
                const idx = frameByteOffset + i * 3;
                imgData.data[i * 4] = pixelData[idx] || 0;
                imgData.data[i * 4 + 1] = pixelData[idx + 1] || 0;
                imgData.data[i * 4 + 2] = pixelData[idx + 2] || 0;
                imgData.data[i * 4 + 3] = 255;
              }
            } else {
              for (let i = 0; i < totalPixels; i++) {
                imgData.data[i * 4] = pixelData[frameByteOffset + i] || 0;
                imgData.data[i * 4 + 1] = pixelData[frameByteOffset + totalPixels + i] || 0;
                imgData.data[i * 4 + 2] = pixelData[frameByteOffset + totalPixels * 2 + i] || 0;
                imgData.data[i * 4 + 3] = 255;
              }
            }
          } else {
            // Grayscale (8-bit or 16-bit auto-scaled)
            for (let i = 0; i < totalPixels; i++) {
              let val = 0;
              if (bytesPerSample === 2) {
                const low = pixelData[frameByteOffset + i * 2] || 0;
                const high = pixelData[frameByteOffset + i * 2 + 1] || 0;
                val = ((high << 8) | low) >> 4;
                if (val > 255) val = 255;
              } else {
                val = pixelData[frameByteOffset + i] || 0;
              }
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

        const ffmpegArgs =
          selectedFormat === 'mp4'
            ? ['-framerate', String(fps), '-i', 'frame_%04d.jpg', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputName]
            : ['-framerate', String(fps), '-i', 'frame_%04d.jpg', outputName];

        await ffmpeg.exec(ffmpegArgs);

        const data = await ffmpeg.readFile(outputName);
        const mimeMap = { mp4: 'video/mp4', avi: 'video/x-msvideo', mpeg: 'video/mpeg' };
        const videoBlob = new Blob([data.buffer], { type: mimeMap[selectedFormat] || 'video/mp4' });

        setDownloadUrl(URL.createObjectURL(videoBlob));
        setProgress(100);
        setStatus(`${selectedFormat.toUpperCase()} video ready for download.`);
      }
    } catch (err) {
      setErrorMsg(err.message || 'Conversion failed. Ensure the DICOM is uncompressed.');
      setStatus('');
    } finally {
      setIsProcessing(false);
    }
  };

  const baseFileName = file ? file.name.replace(/\.[^/.]+$/, '') : 'cardio-dicom';

  return (
    <main style={{ minHeight: '100vh', background: 'radial-gradient(circle at top, #0f172a 0%, #020617 100%)', color: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      
      {/* Main Card */}
      <div style={{ width: '100%', maxWidth: '460px', backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '20px', padding: '28px', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)' }}>
        
        {/* Header with Pulse Icon */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'linear-gradient(135deg, #0ea5e9, #2563eb)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', boxShadow: '0 0 20px rgba(14, 165, 233, 0.4)' }}>
            💓
          </div>
          <div>
            <h1 style={{ fontSize: '20px', fontWeight: '700', margin: 0, letterSpacing: '-0.02em', color: '#ffffff' }}>
              Cardio DICOM Converter
            </h1>
            <p style={{ fontSize: '12px', color: '#94a3b8', margin: '2px 0 0 0' }}>
              Client-Side Echo &amp; Medical Imaging Export
            </p>
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #1e293b', margin: '20px 0' }} />

        {/* Upload Dropzone */}
        <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: '2px dashed #334155', borderRadius: '14px', padding: '24px 16px', backgroundColor: '#020617', cursor: 'pointer', textAlign: 'center', transition: 'border-color 0.2s' }}>
          <span style={{ fontSize: '28px', marginBottom: '8px' }}>📁</span>
          <span style={{ fontSize: '14px', fontWeight: '600', color: '#e2e8f0' }}>
            {file ? file.name : 'Tap to Select DICOM File (.dcm)'}
          </span>
          <span style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
            {file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB • ${dimensions}` : 'Supports cine loops & single-frame scans'}
          </span>
          <input
            type="file"
            accept=".dcm,application/dicom"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
          />
        </label>

        {/* Detected Media Badge */}
        {file && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1e293b', padding: '10px 14px', borderRadius: '10px', marginTop: '16px', fontSize: '13px' }}>
            <span style={{ color: '#94a3b8' }}>Detected Type:</span>
            <span style={{ fontWeight: '600', color: isVideo ? '#38bdf8' : '#34d399' }}>
              {isVideo ? `🎬 Cine Video (${frameCount} frames)` : '🖼️ Still Image (1 frame)'}
            </span>
          </div>
        )}

        {/* Format Selection */}
        {file && (
          <div style={{ marginTop: '18px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: '#cbd5e1', marginBottom: '8px' }}>
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
                      padding: '10px',
                      borderRadius: '10px',
                      border: active ? '2px solid #0ea5e9' : '1px solid #334155',
                      backgroundColor: active ? 'rgba(14, 165, 233, 0.15)' : '#020617',
                      color: active ? '#38bdf8' : '#94a3b8',
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

        {/* Convert Action Button */}
        {file && (
          <button
            type="button"
            onClick={handleConvert}
            disabled={isProcessing}
            style={{
              width: '100%',
              marginTop: '20px',
              padding: '14px',
              borderRadius: '12px',
              border: 'none',
              background: isProcessing ? '#334155' : 'linear-gradient(135deg, #0284c7, #2563eb)',
              color: '#ffffff',
              fontWeight: '700',
              fontSize: '15px',
              cursor: isProcessing ? 'not-allowed' : 'pointer',
              boxShadow: isProcessing ? 'none' : '0 10px 20px -5px rgba(37, 99, 235, 0.5)',
            }}
          >
            {isProcessing ? 'Converting...' : `Convert to ${selectedFormat.toUpperCase()}`}
          </button>
        )}

        {/* Progress Bar & Status */}
        {(isProcessing || status) && (
          <div style={{ marginTop: '16px' }}>
            {isProcessing && (
              <div style={{ width: '100%', height: '6px', backgroundColor: '#1e293b', borderRadius: '999px', overflow: 'hidden', marginBottom: '8px' }}>
                <div style={{ width: `${progress}%`, height: '100%', backgroundColor: '#0ea5e9', transition: 'width 0.3s ease' }} />
              </div>
            )}
            <p style={{ fontSize: '13px', textAlign: 'center', color: '#94a3b8', margin: 0 }}>
              {status}
            </p>
          </div>
        )}

        {/* Error Message */}
        {errorMsg && (
          <div style={{ marginTop: '16px', padding: '12px', borderRadius: '10px', backgroundColor: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', color: '#fca5a5', fontSize: '13px', textAlign: 'center' }}>
            {errorMsg}
          </div>
        )}

        {/* Image Preview & Download Button */}
        {downloadUrl && (
          <div style={{ marginTop: '20px', paddingTop: '18px', borderTop: '1px solid #1e293b' }}>
            {!isVideo && (
              <img
                src={downloadUrl}
                alt="Converted DICOM preview"
                style={{ width: '100%', borderRadius: '10px', marginBottom: '14px', border: '1px solid #334155' }}
              />
            )}
            <a
              href={downloadUrl}
              download={`${baseFileName}.${selectedFormat}`}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'center',
                padding: '14px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #059669, #10b981)',
                color: '#ffffff',
                fontWeight: '700',
                fontSize: '15px',
                textDecoration: 'none',
                boxSizing: 'border-box',
                boxShadow: '0 10px 20px -5px rgba(16, 185, 129, 0.4)',
              }}
            >
              ⬇️ Download {selectedFormat.toUpperCase()} File
            </a>
          </div>
        )}

        {/* Privacy Footer */}
        <p style={{ fontSize: '11px', color: '#64748b', textAlign: 'center', marginTop: '20px', marginBottom: 0 }}>
          🔒 100% Private: Files are converted locally in your browser and never uploaded to any server.
        </p>
      </div>
    </main>
  );
}

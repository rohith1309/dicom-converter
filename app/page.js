'use client';

import { useState, useRef } from 'react';
import dicomParser from 'dicom-parser';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

export default function DicomConverter() {
  const [file, setFile] = useState(null);
  const [isVideo, setIsVideo] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState('');
  const [status, setStatus] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const ffmpegRef = useRef(null);

  const handleFileUpload = async (e) => {
    const uploadedFile = e.target.files[0];
    if (!uploadedFile) return;

    setFile(uploadedFile);
    setDownloadUrl('');
    setStatus('Analyzing DICOM file...');

    const arrayBuffer = await uploadedFile.arrayBuffer();
    const byteArray = new Uint8Array(arrayBuffer);

    try {
      const dataSet = dicomParser.parseDicom(byteArray);
      const numberOfFrames = dataSet.intString('x00280008') || 1;

      if (numberOfFrames > 1) {
        setIsVideo(true);
        setSelectedFormat('mp4');
        setStatus(`Detected multi-frame DICOM video (${numberOfFrames} frames).`);
      } else {
        setIsVideo(false);
        setSelectedFormat('jpeg');
        setStatus('Detected single-frame DICOM image.');
      }
    } catch (error) {
      setStatus('Error parsing DICOM file. Ensure it is a valid .dcm file.');
    }
  };

  const loadFFmpeg = async () => {
    if (!ffmpegRef.current) {
      ffmpegRef.current = new FFmpeg();
    }
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg.loaded) {
      setStatus('Loading conversion engine...');
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
    }
    return ffmpeg;
  };

  const handleConvert = async () => {
    if (!file || !selectedFormat) return;
    setStatus('Processing...');

    const arrayBuffer = await file.arrayBuffer();
    const byteArray = new Uint8Array(arrayBuffer);
    const dataSet = dicomParser.parseDicom(byteArray);

    const rows = dataSet.uint16('x00280010');
    const cols = dataSet.uint16('x00280011');
    const pixelDataElement = dataSet.elements.x7fe00010;
    const pixelData = new Uint8Array(
      dataSet.byteArray.buffer,
      pixelDataElement.dataOffset,
      pixelDataElement.length
    );

    const renderFrameToBlob = (frameOffset) => {
      return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(cols, rows);

        for (let i = 0; i < cols * rows; i++) {
          const val = pixelData[frameOffset + i] || 0;
          imgData.data[i * 4] = val;
          imgData.data[i * 4 + 1] = val;
          imgData.data[i * 4 + 2] = val;
          imgData.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.95);
      });
    };

    if (!isVideo && selectedFormat === 'jpeg') {
      const jpegBlob = await renderFrameToBlob(0);
      setDownloadUrl(URL.createObjectURL(jpegBlob));
      setStatus('Conversion complete!');
      return;
    }

    if (isVideo) {
      const ffmpeg = await loadFFmpeg();
      const numberOfFrames = dataSet.intString('x00280008') || 1;
      const frameSize = cols * rows;

      setStatus('Extracting frames...');
      for (let f = 0; f < numberOfFrames; f++) {
        const blob = await renderFrameToBlob(f * frameSize);
        const buf = new Uint8Array(await blob.arrayBuffer());
        await ffmpeg.writeFile(`frame_${String(f).padStart(4, '0')}.jpg`, buf);
      }

      setStatus(`Encoding to ${selectedFormat.toUpperCase()}...`);
      const outputName = `output.${selectedFormat}`;

      await ffmpeg.exec([
        '-framerate', '15',
        '-i', 'frame_%04d.jpg',
        outputName
      ]);

      const data = await ffmpeg.readFile(outputName);
      const videoBlob = new Blob([data.buffer], { type: `video/${selectedFormat}` });
      setDownloadUrl(URL.createObjectURL(videoBlob));
      setStatus('Video conversion complete!');
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', backgroundColor: '#f3f4f6', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '420px', width: '100%', backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 'bold', textAlign: 'center', marginBottom: '20px', color: '#111827' }}>
          DICOM Converter
        </h1>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: '600', marginBottom: '8px', color: '#374151' }}>
            Upload DICOM (.dcm)
          </label>
          <input
            type="file"
            accept=".dcm,application/dicom"
            onChange={handleFileUpload}
            style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px' }}
          />
        </div>

        {file && (
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: '600', marginBottom: '8px', color: '#374151' }}>
              Which format do you want to download?
            </label>
            <select
              value={selectedFormat}
              onChange={(e) => setSelectedFormat(e.target.value)}
              style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px', backgroundColor: '#ffffff', fontSize: '14px' }}
            >
              {isVideo ? (
                <>
                  <option value="mp4">MP4 Video (.mp4)</option>
                  <option value="avi">AVI Video (.avi)</option>
                  <option value="mpeg">MPEG Video (.mpeg)</option>
                </>
              ) : (
                <option value="jpeg">JPEG Image (.jpeg)</option>
              )}
            </select>
          </div>
        )}

        {file && (
          <button
            onClick={handleConvert}
            style={{ width: '100%', backgroundColor: '#2563eb', color: '#ffffff', fontWeight: '600', padding: '12px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '15px' }}
          >
            Convert File
          </button>
        )}

        {status && (
          <p style={{ fontSize: '14px', textAlign: 'center', color: '#4b5563', marginTop: '14px' }}>
            {status}
          </p>
        )}

        {downloadUrl && (
          <a
            href={downloadUrl}
            download={`converted.${selectedFormat}`}
            style={{ display: 'block', width: '100%', textAlign: 'center', backgroundColor: '#16a34a', color: '#ffffff', fontWeight: '600', padding: '12px', borderRadius: '8px', textDecoration: 'none', marginTop: '14px', fontSize: '15px', boxSizing: 'border-box' }}
          >
            Download {selectedFormat.toUpperCase()}
          </a>
        )}
      </div>
    </main>
  );
}

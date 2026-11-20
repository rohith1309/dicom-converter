export const metadata = {
  title: 'DICOM Converter',
  description: 'Convert DICOM videos and images to MP4, AVI, MPEG, and JPEG',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}

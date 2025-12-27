/**
 * Media tools - audio, video, image processing
 *
 * @module lib/std/tools/media
 */

import { type MiniTool, runCommand } from "./common.ts";

export const mediaTools: MiniTool[] = [
  {
    name: "ffmpeg_convert",
    description:
      "Convert, transcode, and process video/audio files with FFmpeg. Change formats (MP4, WebM, MP3, AAC), resize, trim clips, adjust bitrate/quality. The universal media conversion tool. Keywords: ffmpeg convert, video transcode, audio convert, change format, compress video, trim clip, media processing.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input file path" },
        output: { type: "string", description: "Output file path" },
        videoCodec: { type: "string", description: "Video codec (e.g., libx264, copy)" },
        audioCodec: { type: "string", description: "Audio codec (e.g., aac, copy)" },
        videoBitrate: { type: "string", description: "Video bitrate (e.g., 1M, 5000k)" },
        audioBitrate: { type: "string", description: "Audio bitrate (e.g., 128k)" },
        resolution: { type: "string", description: "Output resolution (e.g., 1920x1080)" },
        startTime: { type: "string", description: "Start time (e.g., 00:01:30)" },
        duration: { type: "string", description: "Duration (e.g., 00:00:30)" },
      },
      required: ["input", "output"],
    },
    handler: async (
      {
        input,
        output,
        videoCodec,
        audioCodec,
        videoBitrate,
        audioBitrate,
        resolution,
        startTime,
        duration,
      },
    ) => {
      const args = ["-i", input as string, "-y"];
      if (startTime) args.push("-ss", startTime as string);
      if (duration) args.push("-t", duration as string);
      if (videoCodec) args.push("-c:v", videoCodec as string);
      if (audioCodec) args.push("-c:a", audioCodec as string);
      if (videoBitrate) args.push("-b:v", videoBitrate as string);
      if (audioBitrate) args.push("-b:a", audioBitrate as string);
      if (resolution) args.push("-s", resolution as string);
      args.push(output as string);

      const result = await runCommand("ffmpeg", args, { timeout: 600000 });
      if (result.code !== 0) {
        throw new Error(`ffmpeg failed: ${result.stderr}`);
      }
      return { success: true, output };
    },
  },
  {
    name: "ffprobe_info",
    description:
      "Analyze media files to get detailed metadata. Shows duration, resolution, codecs, bitrate, frame rate, audio channels, and stream information. Use for video analysis, format detection, or debugging media issues. Keywords: ffprobe, media info, video metadata, file analysis, codec info, duration resolution, stream details.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Media file path" },
      },
      required: ["file"],
    },
    handler: async ({ file }) => {
      const args = [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        file as string,
      ];

      const result = await runCommand("ffprobe", args);
      if (result.code !== 0) {
        throw new Error(`ffprobe failed: ${result.stderr}`);
      }

      try {
        return JSON.parse(result.stdout);
      } catch {
        return { output: result.stdout };
      }
    },
  },
  {
    name: "imagemagick_convert",
    description:
      "Process and transform images with ImageMagick. Resize, crop, rotate, change format (PNG, JPG, WebP, GIF), adjust quality, and apply effects. Powerful image manipulation for batch processing or single files. Keywords: imagemagick, image convert, resize image, crop rotate, change format, image processing, convert png jpg.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input image path" },
        output: { type: "string", description: "Output image path" },
        resize: { type: "string", description: "Resize (e.g., 800x600, 50%)" },
        quality: { type: "number", description: "Quality 1-100" },
        format: { type: "string", description: "Output format (jpg, png, webp, etc.)" },
        rotate: { type: "number", description: "Rotation angle in degrees" },
        crop: { type: "string", description: "Crop geometry (e.g., 100x100+10+10)" },
      },
      required: ["input", "output"],
    },
    handler: async ({ input, output, resize, quality, rotate, crop }) => {
      const args = [input as string];
      if (resize) args.push("-resize", resize as string);
      if (quality) args.push("-quality", String(quality));
      if (rotate) args.push("-rotate", String(rotate));
      if (crop) args.push("-crop", crop as string);
      args.push(output as string);

      const result = await runCommand("convert", args);
      if (result.code !== 0) {
        throw new Error(`convert failed: ${result.stderr}`);
      }
      return { success: true, output };
    },
  },
];

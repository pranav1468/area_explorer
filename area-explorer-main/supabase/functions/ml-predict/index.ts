import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PredictRequest {
  bbox: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  startDate?: string;
  endDate?: string;
  modelName?: string;
  modelVersion?: string;
}

interface SentinelToken {
  access_token: string;
  expires_in: number;
}

type SentinelProvider = "cdse" | "sentinelhub";

type SentinelAuthConfig = {
  provider: SentinelProvider;
  tokenUrl: string;
  processUrl: string;
};

function getSentinelAuthConfig(provider: SentinelProvider): SentinelAuthConfig {
  if (provider === "sentinelhub") {
    return {
      provider,
      tokenUrl: "https://services.sentinel-hub.com/oauth/token",
      processUrl: "https://services.sentinel-hub.com/api/v1/process",
    };
  }

  return {
    provider,
    tokenUrl:
      "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
    processUrl: "https://sh.dataspace.copernicus.eu/api/v1/process",
  };
}

// Get OAuth token (CDSE by default; fallback to Sentinel Hub)
async function getSentinelToken(): Promise<{ accessToken: string; processUrl: string; provider: SentinelProvider }> {
  const clientId = Deno.env.get("SENTINEL_CLIENT_ID");
  const clientSecret = Deno.env.get("SENTINEL_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("Sentinel credentials not configured");
  }

  const tryProvider = async (provider: SentinelProvider) => {
    const cfg = getSentinelAuthConfig(provider);

    const tokenResponse = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(`Token error (${provider}):`, errorText);
      return { ok: false as const, status: tokenResponse.status, errorText, provider };
    }

    const tokenData: SentinelToken = await tokenResponse.json();
    return {
      ok: true as const,
      accessToken: tokenData.access_token,
      processUrl: cfg.processUrl,
      provider,
    };
  };

  // 1) Try Copernicus Data Space (CDSE)
  const cdse = await tryProvider("cdse");
  if (cdse.ok) return { accessToken: cdse.accessToken, processUrl: cdse.processUrl, provider: cdse.provider };

  // 2) Fallback: try Sentinel Hub (common confusion where users provide Sentinel Hub OAuth client)
  const sh = await tryProvider("sentinelhub");
  if (sh.ok) return { accessToken: sh.accessToken, processUrl: sh.processUrl, provider: sh.provider };

  // If both fail, keep original (most informative) error
  throw new Error(`Failed to get Sentinel token: ${cdse.status}`);
}

// Fetch a single band as FLOAT32 array using INT16 + TIFF (widely supported, then convert)
async function fetchBandData(
  accessToken: string,
  processUrl: string,
  bbox: number[],
  band: string,
  startDate: string,
  endDate: string,
  width: number,
  height: number
): Promise<Float32Array> {
  // Use INT16 sample type which is well-supported
  // Scale reflectance (0-1 typical, up to ~2) to INT16 range
  const evalscript = `
//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["${band}"],
      units: "REFLECTANCE"
    }],
    output: {
      bands: 1,
      sampleType: "INT16"
    }
  };
}

function evaluatePixel(sample) {
  // Scale reflectance to INT16: multiply by 10000
  // This gives us 0.0001 precision which is plenty for reflectance
  let val = sample.${band};
  val = Math.max(-3.2, Math.min(3.2, val)); // Clamp to avoid overflow
  return [Math.round(val * 10000)];
}
`;

  const requestBody = {
    input: {
      bounds: {
        bbox: bbox,
        properties: {
          crs: "http://www.opengis.net/def/crs/EPSG/0/4326",
        },
      },
      data: [
        {
          type: "sentinel-2-l2a",
          dataFilter: {
            timeRange: {
              from: startDate,
              to: endDate,
            },
            mosaickingOrder: "leastCC",
          },
        },
      ],
    },
    output: {
      width: width,
      height: height,
      responses: [
        {
          identifier: "default",
          format: { 
            type: "image/tiff",
            compression: "NONE"  // Request uncompressed TIFF to avoid deflate issues
          },
        },
      ],
    },
    evalscript: evalscript,
  };

  const response = await fetch(processUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "image/tiff",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Band ${band} fetch error:`, response.status, errorText);
    throw new Error(`Failed to fetch band ${band}: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  console.log(`Band ${band}: received ${arrayBuffer.byteLength} bytes`);
  
  // Parse TIFF with LZW decompression support
  return parseTiffInt16ToFloat32(arrayBuffer, width, height, band);
}

// Parse TIFF with INT16 data, handling LZW and Deflate compression
async function parseTiffInt16ToFloat32(buffer: ArrayBuffer, width: number, height: number, band: string): Promise<Float32Array> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const totalPixels = width * height;
  
  if (buffer.byteLength < 8) {
    throw new Error('Buffer too small for TIFF');
  }
  
  const byte0 = view.getUint8(0);
  const byte1 = view.getUint8(1);
  const littleEndian = (byte0 === 0x49 && byte1 === 0x49);
  
  if (byte0 !== 0x49 && byte0 !== 0x4D) {
    throw new Error('Invalid TIFF header');
  }
  
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset + 2 > buffer.byteLength) {
    throw new Error('Invalid IFD offset');
  }
  
  const numEntries = view.getUint16(ifdOffset, littleEndian);
  
  let compression = 1;
  let stripOffsets: number[] = [];
  let stripByteCounts: number[] = [];
  let rowsPerStrip = height;
  
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > buffer.byteLength) break;
    
    const tag = view.getUint16(entryOffset, littleEndian);
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    const valueField = entryOffset + 8;
    
    const getValue = () => type === 3 ? view.getUint16(valueField, littleEndian) : view.getUint32(valueField, littleEndian);
    const getPointer = () => view.getUint32(valueField, littleEndian);
    
    switch (tag) {
      case 259: compression = getValue(); break;
      case 278: rowsPerStrip = getValue(); break;
      case 273: // StripOffsets
        if (count === 1) {
          stripOffsets = [getValue()];
        } else {
          const ptr = getPointer();
          for (let j = 0; j < count && ptr + j * 4 + 4 <= buffer.byteLength; j++) {
            stripOffsets.push(view.getUint32(ptr + j * 4, littleEndian));
          }
        }
        break;
      case 279: // StripByteCounts
        if (count === 1) {
          stripByteCounts = [getValue()];
        } else {
          const ptr = getPointer();
          for (let j = 0; j < count && ptr + j * 4 + 4 <= buffer.byteLength; j++) {
            stripByteCounts.push(view.getUint32(ptr + j * 4, littleEndian));
          }
        }
        break;
    }
  }
  
  console.log(`${band} TIFF: compression=${compression}, strips=${stripOffsets.length}`);
  
  const result = new Float32Array(totalPixels);
  
  if (compression === 5) {
    // LZW compression - decompress and read
    let pixelIndex = 0;
    for (let s = 0; s < stripOffsets.length && pixelIndex < totalPixels; s++) {
      const stripData = decompressLZW(bytes, stripOffsets[s], stripByteCounts[s]);
      const stripView = new DataView(stripData.buffer);
      const pixelCount = Math.floor(stripData.length / 2);
      
      for (let i = 0; i < pixelCount && pixelIndex < totalPixels; i++) {
        const int16Val = stripView.getInt16(i * 2, littleEndian);
        result[pixelIndex++] = int16Val / 10000; // Convert back to reflectance
      }
    }
  } else if (compression === 1) {
    // Uncompressed
    let pixelIndex = 0;
    for (let s = 0; s < stripOffsets.length && pixelIndex < totalPixels; s++) {
      const offset = stripOffsets[s];
      const byteCount = stripByteCounts[s] || (totalPixels * 2);
      const pixelCount = Math.floor(byteCount / 2);
      
      for (let i = 0; i < pixelCount && pixelIndex < totalPixels; i++) {
        const pos = offset + i * 2;
        if (pos + 2 <= buffer.byteLength) {
          const int16Val = view.getInt16(pos, littleEndian);
          result[pixelIndex++] = int16Val / 10000;
        }
      }
    }
  } else if (compression === 8 || compression === 32946) {
    // Deflate/ZLIB compression - decompress each strip
    console.log(`Deflate compression detected, attempting decompression`);
    let pixelIndex = 0;
    
    for (let s = 0; s < stripOffsets.length && pixelIndex < totalPixels; s++) {
      try {
        const compressedData = bytes.slice(stripOffsets[s], stripOffsets[s] + stripByteCounts[s]);
        const decompressed = await decompressDeflate(compressedData);
        const stripView = new DataView(decompressed.buffer);
        const pixelCount = Math.floor(decompressed.length / 2);
        
        for (let i = 0; i < pixelCount && pixelIndex < totalPixels; i++) {
          const int16Val = stripView.getInt16(i * 2, littleEndian);
          result[pixelIndex++] = int16Val / 10000;
        }
      } catch (e) {
        console.warn(`Strip ${s} decompression failed:`, e);
        // Fill remaining pixels in strip with zeros
        const expectedPixels = Math.ceil(rowsPerStrip * width);
        for (let i = 0; i < expectedPixels && pixelIndex < totalPixels; i++) {
          result[pixelIndex++] = 0;
        }
      }
    }
    
    if (pixelIndex < totalPixels * 0.5) {
      console.warn(`Only ${pixelIndex}/${totalPixels} pixels extracted, using fallback`);
      return extractFallback(buffer, width, height, littleEndian);
    }
  } else {
    console.warn(`Unknown compression ${compression}, using fallback`);
    return extractFallback(buffer, width, height, littleEndian);
  }
  
  return result;
}

// LZW decompression for TIFF
function decompressLZW(input: Uint8Array, offset: number, length: number): Uint8Array {
  const output: number[] = [];
  const dictionary: number[][] = [];
  
  // Initialize dictionary with single-byte entries
  for (let i = 0; i < 256; i++) {
    dictionary[i] = [i];
  }
  
  const CLEAR_CODE = 256;
  const EOI_CODE = 257;
  let nextCode = 258;
  let codeSize = 9;
  
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let bytePos = offset;
  const endPos = offset + length;
  
  const readCode = (): number => {
    while (bitsInBuffer < codeSize && bytePos < endPos) {
      bitBuffer = (bitBuffer << 8) | input[bytePos++];
      bitsInBuffer += 8;
    }
    if (bitsInBuffer < codeSize) return EOI_CODE;
    
    bitsInBuffer -= codeSize;
    return (bitBuffer >> bitsInBuffer) & ((1 << codeSize) - 1);
  };
  
  let oldCode = -1;
  
  while (bytePos < endPos || bitsInBuffer >= codeSize) {
    const code = readCode();
    
    if (code === EOI_CODE) break;
    
    if (code === CLEAR_CODE) {
      // Reset dictionary
      dictionary.length = 258;
      for (let i = 0; i < 256; i++) dictionary[i] = [i];
      nextCode = 258;
      codeSize = 9;
      oldCode = -1;
      continue;
    }
    
    let entry: number[];
    if (code < dictionary.length) {
      entry = dictionary[code];
    } else if (code === nextCode && oldCode >= 0) {
      entry = [...dictionary[oldCode], dictionary[oldCode][0]];
    } else {
      console.warn(`Invalid LZW code ${code}`);
      break;
    }
    
    output.push(...entry);
    
    if (oldCode >= 0 && nextCode < 4096) {
      dictionary[nextCode++] = [...dictionary[oldCode], entry[0]];
      if (nextCode >= (1 << codeSize) && codeSize < 12) {
        codeSize++;
      }
    }
    
    oldCode = code;
  }
  
  return new Uint8Array(output);
}

// Decompress Deflate/ZLIB compressed data using native DecompressionStream
async function decompressDeflate(data: Uint8Array): Promise<Uint8Array> {
  // Try raw deflate first, then zlib format
  const formats: CompressionFormat[] = ['deflate-raw', 'deflate'];
  
  for (const format of formats) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      
      const chunks: Uint8Array[] = [];
      
      // Write data - create a new ArrayBuffer to satisfy type requirements
      const dataBuffer = new Uint8Array(data.length);
      dataBuffer.set(data);
      writer.write(dataBuffer.buffer);
      writer.close();
      
      // Read all chunks
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(new Uint8Array(value));
      }
      
      // Combine chunks
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      
      return result;
    } catch {
      // Try next format
      continue;
    }
  }
  
  throw new Error('Failed to decompress with any format');
}

// Fallback extraction when compression isn't handled
function extractFallback(buffer: ArrayBuffer, width: number, height: number, littleEndian: boolean): Float32Array {
  const view = new DataView(buffer);
  const totalPixels = width * height;
  const result = new Float32Array(totalPixels);
  
  // Try to find INT16 data at common offsets
  const expectedBytes = totalPixels * 2;
  const possibleStarts = [8, 256, 512, buffer.byteLength - expectedBytes];
  
  for (const start of possibleStarts) {
    if (start >= 0 && start + expectedBytes <= buffer.byteLength) {
      let validSamples = 0;
      for (let i = 0; i < Math.min(100, totalPixels); i++) {
        const val = view.getInt16(start + i * 2, littleEndian) / 10000;
        if (val >= -1 && val <= 2) validSamples++;
      }
      
      if (validSamples > 80) {
        for (let i = 0; i < totalPixels; i++) {
          result[i] = view.getInt16(start + i * 2, littleEndian) / 10000;
        }
        console.log(`Fallback: found valid data at offset ${start}`);
        return result;
      }
    }
  }
  
  // Last resort: return zeros (will show as no data but won't crash)
  console.warn('Could not extract raster data, returning zeros');
  return result;
}


// Convert Float32Array to base64
function float32ArrayToBase64(array: Float32Array): string {
  const uint8Array = new Uint8Array(array.buffer);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
}

// Generate a simple NDVI-based segmentation mask as PNG data URL
function generateNdviMask(
  b04Data: Float32Array, // Red
  b08Data: Float32Array, // NIR
  width: number,
  height: number
): { maskDataUrl: string; forestPercentage: number } {
  // Calculate NDVI for each pixel
  const ndvi = new Float32Array(width * height);
  let forestPixels = 0;
  
  for (let i = 0; i < width * height; i++) {
    const red = b04Data[i];
    const nir = b08Data[i];
    
    if (nir + red > 0) {
      ndvi[i] = (nir - red) / (nir + red);
    } else {
      ndvi[i] = 0;
    }
    
    // NDVI > 0.3 is typically vegetation/forest
    if (ndvi[i] > 0.3) {
      forestPixels++;
    }
  }
  
  // Create RGBA image data
  const rgba = new Uint8Array(width * height * 4);
  
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const val = ndvi[i];
    
    if (val > 0.6) {
      // Dense forest - dark green
      rgba[idx] = 0;      // R
      rgba[idx + 1] = 128; // G
      rgba[idx + 2] = 0;   // B
      rgba[idx + 3] = 200; // A
    } else if (val > 0.4) {
      // Moderate vegetation - medium green
      rgba[idx] = 34;
      rgba[idx + 1] = 139;
      rgba[idx + 2] = 34;
      rgba[idx + 3] = 180;
    } else if (val > 0.2) {
      // Sparse vegetation - light green
      rgba[idx] = 144;
      rgba[idx + 1] = 238;
      rgba[idx + 2] = 144;
      rgba[idx + 3] = 150;
    } else if (val > 0) {
      // Bare soil/low vegetation - tan
      rgba[idx] = 210;
      rgba[idx + 1] = 180;
      rgba[idx + 2] = 140;
      rgba[idx + 3] = 120;
    } else {
      // Water/non-vegetation - blue tint or transparent
      rgba[idx] = 65;
      rgba[idx + 1] = 105;
      rgba[idx + 2] = 225;
      rgba[idx + 3] = val < -0.1 ? 150 : 50; // More opaque for water
    }
  }
  
  // Create a simple PPM-style encoding then convert to base64 PNG
  // Using a simpler BMP format that's easier to create
  const bmpData = createBMP(rgba, width, height);
  const base64 = btoa(String.fromCharCode(...bmpData));
  
  return {
    maskDataUrl: `data:image/bmp;base64,${base64}`,
    forestPercentage: (forestPixels / (width * height)) * 100
  };
}

// Create a simple BMP file from RGBA data
function createBMP(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 4) / 4) * 4; // BMP rows are 4-byte aligned
  const imageSize = rowSize * height;
  const fileSize = 54 + imageSize;
  
  const bmp = new Uint8Array(fileSize);
  const view = new DataView(bmp.buffer);
  
  // BMP Header (14 bytes)
  bmp[0] = 0x42; // 'B'
  bmp[1] = 0x4D; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true); // Pixel data offset
  
  // DIB Header (40 bytes)
  view.setUint32(14, 40, true); // DIB header size
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true); // Negative for top-down
  view.setUint16(26, 1, true); // Color planes
  view.setUint16(28, 32, true); // Bits per pixel (BGRA)
  view.setUint32(30, 0, true); // No compression
  view.setUint32(34, imageSize, true);
  view.setUint32(38, 2835, true); // Horizontal resolution
  view.setUint32(42, 2835, true); // Vertical resolution
  
  // Pixel data (BGRA format for BMP)
  let offset = 54;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      bmp[offset++] = rgba[srcIdx + 2]; // B
      bmp[offset++] = rgba[srcIdx + 1]; // G
      bmp[offset++] = rgba[srcIdx];     // R
      bmp[offset++] = rgba[srcIdx + 3]; // A
    }
    // Padding to 4-byte boundary (not needed for 32-bit)
  }
  
  return bmp;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ML_MODEL_URL = Deno.env.get('ML_MODEL_URL');
    const useDemoMode = !ML_MODEL_URL;
    
    if (useDemoMode) {
      console.log('ML Model URL not configured - using NDVI demo mode');
    }

    const body: PredictRequest = await req.json();
    const { 
      bbox, 
      startDate: rawStartDate,
      endDate: rawEndDate,
      modelName = 'forest_segmentation',
      modelVersion = 'v1'
    } = body;

    // Convert dates to ISO-8601 format required by Sentinel Hub
    const formatDate = (dateStr: string | undefined, isEnd: boolean): string => {
      if (!dateStr) {
        const d = isEnd ? new Date() : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return d.toISOString();
      }
      // If already has time component, return as-is
      if (dateStr.includes('T')) return dateStr;
      // Add time component: start of day for from, end of day for to
      return isEnd ? `${dateStr}T23:59:59Z` : `${dateStr}T00:00:00Z`;
    };

    const startDate = formatDate(rawStartDate, false);
    const endDate = formatDate(rawEndDate, true);

    if (!bbox) {
      return new Response(
        JSON.stringify({ error: 'bbox is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Fetching Sentinel-2 bands for bbox:', bbox);
    console.log('Date range:', startDate, 'to', endDate);

    // Get OAuth token
    const { accessToken, processUrl, provider } = await getSentinelToken();
    console.log(`Got Sentinel token (provider=${provider})`);

    // Define bands to fetch
    const bands = ['B02', 'B03', 'B04', 'B08', 'B11', 'B12'];
    const bboxArray = [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat];

    // Calculate dimensions (256x256 for ML model)
    const width = 256;
    const height = 256;

    // Fetch all bands in parallel
    console.log('Fetching bands:', bands.join(', '));
    const bandDataPromises = bands.map((band) =>
      fetchBandData(accessToken, processUrl, bboxArray, band, startDate, endDate, width, height)
    );

    const bandDataArrays = await Promise.all(bandDataPromises);
    console.log('All bands fetched successfully');

    // Create band data map for easy access
    const bandDataMap: Record<string, Float32Array> = {};
    bands.forEach((band, index) => {
      bandDataMap[band] = bandDataArrays[index];
    });

    // If demo mode (no ML_MODEL_URL), generate NDVI-based mask
    if (useDemoMode) {
      console.log('Generating NDVI-based demo mask');
      const { maskDataUrl, forestPercentage } = generateNdviMask(
        bandDataMap['B04'], // Red band
        bandDataMap['B08'], // NIR band
        width,
        height
      );

      return new Response(
        JSON.stringify({
          success: true,
          prediction: {
            mask: maskDataUrl,
            forest_percentage: Math.round(forestPercentage * 10) / 10,
            confidence: 0.75,
            classes: ['Dense Forest', 'Moderate Vegetation', 'Sparse Vegetation', 'Bare Soil', 'Water'],
            demo_mode: true,
          },
          bbox,
          modelName: 'ndvi_demo',
          modelVersion: 'v1',
          width,
          height
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Encode bands as base64 for ML model
    const bandsPayload: Record<string, string> = {};
    bands.forEach((band, index) => {
      bandsPayload[band] = float32ArrayToBase64(bandDataArrays[index]);
    });

    // Prepare ML model payload
    const mlPayload = {
      model_name: modelName,
      model_version: modelVersion,
      bands: bandsPayload,
      width: width,
      height: height,
      bbox: bbox
    };

    console.log('Sending to ML model:', ML_MODEL_URL);
    console.log('Payload keys:', Object.keys(mlPayload));

    // Call ML model directly (no /predict suffix)
    const mlResponse = await fetch(ML_MODEL_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mlPayload),
    });

    if (!mlResponse.ok) {
      const errorText = await mlResponse.text();
      console.error('ML model error:', mlResponse.status, errorText);
      return new Response(
        JSON.stringify({ 
          error: 'ML model prediction failed',
          status: mlResponse.status,
          details: errorText
        }),
        { status: mlResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = await mlResponse.json();
    console.log('ML prediction successful');

    return new Response(
      JSON.stringify({
        success: true,
        prediction: result,
        bbox,
        modelName,
        modelVersion,
        width,
        height
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in ml-predict function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    
    // Check if it's a connection error
    if (errorMessage.includes('connect') || errorMessage.includes('refused')) {
      return new Response(
        JSON.stringify({ 
          error: 'Cannot connect to ML model',
          message: 'Make sure your ML server is running and accessible'
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

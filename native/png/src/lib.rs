//! Lossless PNG encoding only. Capture, color conversion and presentation stay platform-owned.
use std::{borrow::Cow, io::Write, ptr};

#[repr(C)]
pub struct PngBuffer {
    pub data: *mut u8,
    pub len: usize,
}
const MAX_PIXELS: usize = 8_000_000;

fn encode(
    input: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    bits: u32,
    preset: u32,
    profile: &[u8],
) -> Result<Vec<u8>, ()> {
    if width == 0
        || height == 0
        || ![8, 16].contains(&bits)
        || ![1, 2].contains(&preset)
        || profile.len() > 1_048_576
    {
        return Err(());
    }
    let pixels = (width as usize).checked_mul(height as usize).ok_or(())?;
    if pixels > MAX_PIXELS {
        return Err(());
    }
    let row = (width as usize)
        .checked_mul(4 * (bits as usize / 8))
        .ok_or(())?;
    let needed = stride
        .checked_mul(height as usize - 1)
        .and_then(|n| n.checked_add(row))
        .ok_or(())?;
    if stride < row || input.len() < needed || (preset == 2 && bits != 8) {
        return Err(());
    }
    // Drop alpha only when every sample is fully opaque. Android's input is
    // premultiplied, so nonopaque Android input must use the platform fallback.
    let opaque = (0..height as usize).all(|y| {
        let line = &input[y * stride..y * stride + row];
        if bits == 16 {
            line.as_chunks::<8>()
                .0
                .iter()
                .all(|p| p[6..8] == [255, 255])
        } else {
            line.as_chunks::<4>().0.iter().all(|p| p[3] == 255)
        }
    });
    if preset == 2 && !opaque {
        return Err(());
    }
    let rgb = opaque;
    let mut packed = Vec::new();
    packed
        .try_reserve_exact(
            pixels
                .checked_mul((if rgb { 3 } else { 4 }) * bits as usize / 8)
                .ok_or(())?,
        )
        .map_err(|_| ())?;
    for y in 0..height as usize {
        let line = &input[y * stride..y * stride + row];
        if bits == 16 {
            // Core Image RGBA16 is native-endian; PNG samples are big-endian.
            for pixel in line.as_chunks::<8>().0 {
                let channels = if rgb { &pixel[..6] } else { &pixel[..] };
                for p in channels.as_chunks::<2>().0 {
                    packed.extend_from_slice(&u16::from_ne_bytes([p[0], p[1]]).to_be_bytes());
                }
            }
        } else if rgb {
            for p in line.as_chunks::<4>().0 {
                packed.extend_from_slice(&p[..3]);
            }
        } else {
            packed.extend_from_slice(line);
        }
    }
    let mut info = png::Info::with_size(width, height);
    info.color_type = if rgb {
        png::ColorType::Rgb
    } else {
        png::ColorType::Rgba
    };
    info.bit_depth = if bits == 16 {
        png::BitDepth::Sixteen
    } else {
        png::BitDepth::Eight
    };
    if !profile.is_empty() {
        info.icc_profile = Some(Cow::Borrowed(profile));
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::with_info(&mut output, info).map_err(|_| ())?;
        encoder.set_compression(if preset == 1 {
            png::Compression::Fast
        } else {
            png::Compression::Default
        });
        encoder.set_filter(if preset == 1 {
            png::FilterType::Up
        } else {
            png::FilterType::NoFilter
        });
        let mut writer = encoder.write_header().map_err(|_| ())?;
        let mut stream = writer.stream_writer().map_err(|_| ())?;
        stream.write_all(&packed).map_err(|_| ())?;
        stream.finish().map_err(|_| ())?;
    }
    Ok(output)
}

/// # Safety
/// Inputs must reference readable buffers of the specified lengths, and `output`
/// must be writable. Pixels are straight RGBA, RGBA16 native-endian, or opaque
/// Android RGBA8. An owned successful result must be freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn native_ui_png_encode(
    input: *const u8,
    input_len: usize,
    width: u32,
    height: u32,
    stride: usize,
    bits: u32,
    preset: u32,
    profile: *const u8,
    profile_len: usize,
    output: *mut PngBuffer,
) -> i32 {
    if output.is_null() {
        return 1;
    }
    ptr::write(
        output,
        PngBuffer {
            data: ptr::null_mut(),
            len: 0,
        },
    );
    if input.is_null()
        || input_len > isize::MAX as usize
        || profile_len > 1_048_576
        || (profile.is_null() && profile_len != 0)
    {
        return 1;
    }
    let result = std::panic::catch_unwind(|| {
        let bytes = std::slice::from_raw_parts(input, input_len);
        let icc = if profile_len == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(profile, profile_len)
        };
        encode(bytes, width, height, stride, bits, preset, icc)
    });
    match result {
        Ok(Ok(png)) => {
            let mut png = png.into_boxed_slice();
            let result = PngBuffer {
                data: png.as_mut_ptr(),
                len: png.len(),
            };
            std::mem::forget(png);
            ptr::write(output, result);
            0
        }
        _ => 1,
    }
}
/// # Safety
/// The buffer must be an unmodified successful encoder result, freed only once.
#[no_mangle]
pub unsafe extern "C" fn native_ui_png_free(buffer: PngBuffer) {
    if !buffer.data.is_null() {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
            buffer.data,
            buffer.len,
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn decode(bytes: Vec<u8>) -> (png::OutputInfo, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut decoded = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut decoded).unwrap();
        decoded.truncate(info.buffer_size());
        (info, decoded)
    }
    #[test]
    fn opaque_android_drops_only_alpha_and_ignores_stride_padding() {
        let bytes = [1, 2, 3, 255, 99, 99, 99, 99, 4, 5, 6, 255];
        let (info, decoded) = decode(encode(&bytes, 1, 2, 8, 8, 2, &[]).unwrap());
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(decoded, [1, 2, 3, 4, 5, 6]);
    }
    #[test]
    fn transparent_android_requests_platform_fallback() {
        assert!(encode(&[1, 2, 3, 128], 1, 1, 4, 8, 2, &[]).is_err());
    }
    #[test]
    fn ios_16bit_keeps_sample_precision_and_alpha() {
        let samples = [1234u16, 23456, 65432, 32768];
        let bytes: Vec<_> = samples.iter().flat_map(|n| n.to_ne_bytes()).collect();
        let (info, decoded) = decode(encode(&bytes, 1, 1, 8, 16, 1, &[]).unwrap());
        assert_eq!(info.bit_depth, png::BitDepth::Sixteen);
        assert_eq!(
            decoded,
            samples
                .iter()
                .flat_map(|n| n.to_be_bytes())
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn opaque_ios_preserves_sixteen_bit_rgb() {
        let samples = [1234u16, 23456, 65432, 65535];
        let bytes: Vec<_> = samples.iter().flat_map(|n| n.to_ne_bytes()).collect();
        let (info, decoded) = decode(encode(&bytes, 1, 1, 8, 16, 1, &[]).unwrap());
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(info.bit_depth, png::BitDepth::Sixteen);
        assert_eq!(
            decoded,
            samples[..3]
                .iter()
                .flat_map(|n| n.to_be_bytes())
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn invalid_dimensions_and_truncated_buffers_fail() {
        for (w, h, stride) in [
            (0, 1, 4),
            (1, 0, 4),
            (1, 1, 3),
            (2, 1, 8),
            (u32::MAX, u32::MAX, usize::MAX),
        ] {
            assert!(encode(&[0; 4], w, h, stride, 8, 1, &[]).is_err());
        }
    }
    #[test]
    fn ffi_clears_output_on_failure_and_releases_success() {
        unsafe {
            let mut out = PngBuffer {
                data: ptr::null_mut(),
                len: 999,
            };
            assert_eq!(
                native_ui_png_encode(ptr::null(), 0, 1, 1, 4, 8, 1, ptr::null(), 0, &mut out),
                1
            );
            assert_eq!(out.len, 0);
            assert_eq!(
                native_ui_png_encode(
                    [1, 2, 3, 255].as_ptr(),
                    4,
                    1,
                    1,
                    4,
                    8,
                    1,
                    ptr::null(),
                    0,
                    &mut out
                ),
                0
            );
            assert!(!out.data.is_null());
            native_ui_png_free(out);
        }
    }
}

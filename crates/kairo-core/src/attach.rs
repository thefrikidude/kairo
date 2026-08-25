use std::io::{Read, Write};

use crate::{KairoError, Result};

const OUTPUT: u8 = 1;
const INPUT: u8 = 2;
const INTERRUPT: u8 = 3;
const DETACH: u8 = 4;
const MAX_FRAME_SIZE: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachFrame {
    Output(Vec<u8>),
    Input(String),
    Interrupt,
    Detach,
}

pub fn write_attach_frame(writer: &mut impl Write, frame: &AttachFrame) -> Result<()> {
    let (kind, payload) = match frame {
        AttachFrame::Output(bytes) => (OUTPUT, bytes.as_slice()),
        AttachFrame::Input(input) => (INPUT, input.as_bytes()),
        AttachFrame::Interrupt => (INTERRUPT, &[] as &[u8]),
        AttachFrame::Detach => (DETACH, &[] as &[u8]),
    };
    let length = u32::try_from(payload.len())
        .map_err(|_| KairoError::Protocol("attach frame is too large".to_owned()))?;
    writer.write_all(&[kind])?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

pub fn read_attach_frame(reader: &mut impl Read) -> Result<AttachFrame> {
    let mut kind = [0_u8; 1];
    reader.read_exact(&mut kind)?;
    let mut encoded_length = [0_u8; 4];
    reader.read_exact(&mut encoded_length)?;
    let length = u32::from_be_bytes(encoded_length) as usize;
    if length > MAX_FRAME_SIZE {
        return Err(KairoError::Protocol("attach frame is too large".to_owned()));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    match kind[0] {
        OUTPUT => Ok(AttachFrame::Output(payload)),
        INPUT => String::from_utf8(payload)
            .map(AttachFrame::Input)
            .map_err(|_| KairoError::Protocol("attach input must be valid UTF-8".to_owned())),
        INTERRUPT if payload.is_empty() => Ok(AttachFrame::Interrupt),
        DETACH if payload.is_empty() => Ok(AttachFrame::Detach),
        _ => Err(KairoError::Protocol("invalid attach frame".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::{AttachFrame, read_attach_frame, write_attach_frame};

    #[test]
    fn attach_frames_round_trip_binary_output() {
        let frame = AttachFrame::Output(vec![0, 255, b'\n']);
        let mut encoded = Vec::new();
        write_attach_frame(&mut encoded, &frame).expect("frame serializes");
        assert_eq!(read_attach_frame(&mut encoded.as_slice()).expect("frame deserializes"), frame);
    }
}

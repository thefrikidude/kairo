use std::collections::VecDeque;

pub const TRANSCRIPT_CAPACITY: usize = 64 * 1024;

#[derive(Debug)]
pub struct Transcript {
    bytes: VecDeque<u8>,
    capacity: usize,
}

impl Transcript {
    pub fn new(capacity: usize) -> Self {
        Self { bytes: VecDeque::with_capacity(capacity), capacity }
    }

    pub fn append(&mut self, output: &[u8]) {
        if self.capacity == 0 {
            return;
        }
        if output.len() >= self.capacity {
            self.bytes.clear();
            self.bytes.extend(&output[output.len() - self.capacity..]);
            return;
        }

        let overflow = self.bytes.len().saturating_add(output.len()).saturating_sub(self.capacity);
        self.bytes.drain(..overflow);
        self.bytes.extend(output);
    }

    pub fn text(&self) -> String {
        let bytes = self.bytes.iter().copied().collect::<Vec<_>>();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl Default for Transcript {
    fn default() -> Self {
        Self::new(TRANSCRIPT_CAPACITY)
    }
}

#[cfg(test)]
mod tests {
    use super::Transcript;

    #[test]
    fn retains_only_the_most_recent_bytes() {
        let mut transcript = Transcript::new(5);
        transcript.append(b"abc");
        transcript.append(b"def");

        assert_eq!(transcript.text(), "bcdef");
    }

    #[test]
    fn large_append_replaces_the_entire_transcript() {
        let mut transcript = Transcript::new(4);
        transcript.append(b"abcdef");

        assert_eq!(transcript.text(), "cdef");
    }
}

//! Per-project port allocation within an inclusive range.

use crate::types::PortRange;

/// Allocates unique ports for agents within a given inclusive range, avoiding ports already in use
/// or already handed out. One allocator instance owns one range.
pub struct PortAllocator {
    range: PortRange,
    assigned: std::collections::HashSet<u16>,
}

impl PortAllocator {
    /// Create an allocator over the given inclusive range.
    pub fn new(range: PortRange) -> Self {
        Self {
            range,
            assigned: std::collections::HashSet::new(),
        }
    }

    /// Allocate the next free port within the range that no agent already holds.
    ///
    /// Errors with `No free port available in range {start}-{end}` when the range is exhausted.
    pub fn allocate(&mut self) -> anyhow::Result<u16> {
        for port in self.range.start..=self.range.end {
            if self.assigned.contains(&port) {
                continue;
            }
            if is_free(port) {
                self.assigned.insert(port);
                return Ok(port);
            }
        }
        anyhow::bail!(
            "No free port available in range {}-{}",
            self.range.start,
            self.range.end
        )
    }

    /// Release a previously allocated port, making it available again.
    pub fn release(&mut self, port: u16) {
        self.assigned.remove(&port);
    }

    /// Mark a specific port as already taken. Ports outside this allocator's range are ignored.
    pub fn reserve(&mut self, port: u16) {
        if port >= self.range.start && port <= self.range.end {
            self.assigned.insert(port);
        }
    }
}

/// Whether a TCP port on 127.0.0.1 is free to bind.
pub fn is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(start: u16, end: u16) -> PortRange {
        PortRange { start, end }
    }

    #[test]
    fn reserve_then_allocate_returns_different_in_range() {
        // Use a high ephemeral range likely to be free on 127.0.0.1.
        let mut alloc = PortAllocator::new(range(54000, 54010));
        alloc.reserve(54000);
        let p = alloc.allocate().unwrap();
        assert!(p >= 54000 && p <= 54010, "port {p} out of range");
        assert_ne!(p, 54000, "allocated the reserved port");
    }

    #[test]
    fn release_frees_a_port_for_reuse() {
        let mut alloc = PortAllocator::new(range(54100, 54100));
        let p = alloc.allocate().unwrap();
        assert_eq!(p, 54100);
        alloc.release(p);
        let p2 = alloc.allocate().unwrap();
        assert_eq!(p2, 54100, "released port should be reusable");
    }

    #[test]
    fn exhausted_range_errors() {
        let mut alloc = PortAllocator::new(range(54200, 54200));
        alloc.reserve(54200);
        let err = alloc.allocate().unwrap_err().to_string();
        assert!(err.contains("No free port available"), "got: {err}");
    }
}

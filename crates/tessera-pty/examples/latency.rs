//! Host-only latency; macOS uses raw, no-echo cat, Windows uses a ReadKey echo loop.
//! Run: cargo run --release -p tessera-pty --example latency
mod support;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut samples = support::latency(1000)?;
    samples.sort_by(f64::total_cmp);
    println!(
        "1000 host round trips: p50={:.3} ms p95={:.3} ms p99={:.3} ms",
        samples[499], samples[949], samples[989]
    );
    Ok(())
}

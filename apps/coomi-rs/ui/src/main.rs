use anyhow::Result;
use clap::Parser;
use coomi_ui::Cli;

#[tokio::main]
async fn main() -> Result<()> {
    coomi_ui::run(Cli::parse()).await
}

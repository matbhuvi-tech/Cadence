use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "src/remote/dist/"]
pub struct PwaAssets;

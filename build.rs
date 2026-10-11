// Windows: embed the icon and version details in devtree.exe, so Explorer, the taskbar and
// "Properties" show DevTree instead of a blank program.
fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico")
            .set("ProductName", "DevTree")
            .set("FileDescription", "DevTree – a lightweight git client")
            .set("LegalCopyright", "DevTree contributors");
        if let Err(e) = res.compile() {
            // A missing resource compiler only costs the icon; don't fail the build for it.
            println!("cargo:warning=could not embed the Windows icon: {e}");
        }
    }
}

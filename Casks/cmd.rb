# The Homebrew cask for cmd: `brew tap janoelze/cmd https://github.com/janoelze/cmd`,
# then `brew install --cask janoelze/cmd/cmd`. A release (the `release` job in
# .github/workflows/build.yml) sets version and sha256 to its .zip.
cask "cmd" do
  version "0.27.2"
  sha256 "07217d88c0aa64caebc90b2df7efe5278588546d80e9083d0c4fd49bb1b9003c"

  url "https://github.com/janoelze/cmd/releases/download/v#{version}/cmd-#{version}-arm64.zip"
  name "cmd"
  desc "Terminals and coding agents side by side"
  homepage "https://endtime-instruments.org/cmd/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "cmd.app"

  uninstall quit: "dev.janoelze.cmd"

  zap trash: [
    "~/.config/cmd",
    "~/Library/Application Support/cmd",
    "~/Library/Caches/cmd-updater",
    "~/Library/Logs/cmd",
    "~/Library/Preferences/dev.janoelze.cmd.plist",
    "~/Library/Saved Application State/dev.janoelze.cmd.savedState",
  ]
end

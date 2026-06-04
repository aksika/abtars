class Abtars < Formula
  desc "AI bridge — connect LLMs to Telegram, Discord, and more"
  homepage "https://github.com/aksika/abtars"
  url "https://registry.npmjs.org/abtars/-/abtars-0.2.1-alpha.8.tgz"
  sha256 "8d808e13a6b7061aece90a614e00ff44a715cdaa9aa6884ec881a16e478e92b5"
  license "Apache-2.0"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def post_install
    system bin/"abtars", "install", "--mode=simple"
    system bin/"abtars", "update"
  end

  def caveats
    <<~EOS
      To complete setup:
        abtars onboard

      To add persistent memory:
        npm install -g abmind
        abmind install
        abtars restart
    EOS
  end

  test do
    assert_match "abtars", shell_output("#{bin}/abtars --help")
  end
end

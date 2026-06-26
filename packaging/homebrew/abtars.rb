class Abtars < Formula
  desc "AI bridge — connect LLMs to Telegram, Discord, and more"
  homepage "https://github.com/aksika/abtars"
  url "https://registry.npmjs.org/abtars/-/abtars-0.3.1-alpha.0.tgz"
  sha256 "PLACEHOLDER"
  license "Apache-2.0"

  depends_on "node@24"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def post_install
    system bin/"abtars", "install", "--mode=simple", "--force"
  end

  def caveats
    <<~EOS
      To complete setup:
        abtars install

      To add persistent memory:
        pnpm install -g abmind@alpha
        pnpm approve-builds -g
        abmind install
        abtars restart
    EOS
  end

  test do
    assert_match "abtars", shell_output("#{bin}/abtars --help")
  end
end

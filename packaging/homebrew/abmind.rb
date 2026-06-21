class Abmind < Formula
  desc "Standalone AI agent memory system — SQLite, FTS5, embeddings, recall, sleep"
  homepage "https://github.com/aksika/abmind"
  url "https://registry.npmjs.org/abmind/-/abmind-0.2.2-alpha.0.tgz"
  sha256 "PLACEHOLDER"
  license "Apache-2.0"

  depends_on "node@24"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def post_install
    ohai "Run 'abmind install' to initialize the memory system"
  end

  def caveats
    <<~EOS
      After install, initialize memory:
        abmind install

      This creates ~/.abmind/ with the memory database and core files.
      Requires ollama for local embeddings (recommended):
        brew install ollama
        ollama pull nomic-embed-text
    EOS
  end

  test do
    assert_match "abmind", shell_output("#{bin}/abmind --help")
  end
end

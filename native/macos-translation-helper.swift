import Darwin
import Foundation
import NaturalLanguage
import Translation

private struct TranslationInput: Decodable {
    let texts: [String]
    let source: String
    let target: String
}

private struct TranslationOutput: Encodable {
    let translations: [String]
    let source: String
    let target: String
}

private enum HelperError: LocalizedError {
    case invalidInput(String)
    case sourceLanguageDetectionFailed
    case unsupportedLanguagePair(String, String)
    case languagePairNotInstalled(String, String)

    var errorDescription: String? {
        switch self {
        case .invalidInput(let message):
            return "Invalid helper input: \(message)"
        case .sourceLanguageDetectionFailed:
            return "Apple Translation could not detect the source language. Set sourceLanguage explicitly."
        case .unsupportedLanguagePair(let source, let target):
            return "Apple Translation does not support \(source) -> \(target)."
        case .languagePairNotInstalled(let source, let target):
            return "Apple Translation languages for \(source) -> \(target) are not installed. Download them in System Settings > General > Language & Region > Translation Languages."
        }
    }
}

@available(macOS 26.0, *)
private func resolveSourceLanguage(_ identifier: String, texts: [String]) throws -> Locale.Language {
    if identifier.lowercased() != "auto" {
        return Locale.Language(identifier: identifier)
    }

    let recognizer = NLLanguageRecognizer()
    recognizer.processString(texts.joined(separator: "\n"))
    guard let detected = recognizer.dominantLanguage else {
        throw HelperError.sourceLanguageDetectionFailed
    }
    return Locale.Language(identifier: detected.rawValue)
}

@available(macOS 26.0, *)
private func translate(_ input: TranslationInput) async throws -> TranslationOutput {
    guard !input.texts.isEmpty else {
        throw HelperError.invalidInput("texts must not be empty")
    }

    let source = try resolveSourceLanguage(input.source, texts: input.texts)
    let target = Locale.Language(identifier: input.target)
    let availability = LanguageAvailability()

    // `LanguageAvailability` can briefly report `.supported` while a language
    // pack is already installed (or while the system is refreshing its cache).
    // Let the session be the source of truth so a stale status does not turn a
    // successful translation into a misleading "languages not installed" error.
    let availabilityStatus = await availability.status(from: source, to: target)
    switch availabilityStatus {
    case .installed, .supported:
        break
    case .unsupported:
        throw HelperError.unsupportedLanguagePair(source.minimalIdentifier, target.minimalIdentifier)
    @unknown default:
        throw HelperError.unsupportedLanguagePair(source.minimalIdentifier, target.minimalIdentifier)
    }

    let session = TranslationSession(installedSource: source, target: target)
    let requests = input.texts.enumerated().map { index, text in
        TranslationSession.Request(sourceText: text, clientIdentifier: String(index))
    }
    let responses: [TranslationSession.Response]
    do {
        responses = try await session.translations(from: requests)
    } catch {
        // Only turn a failed session into the actionable download hint when
        // availability also says the pair is supported but not installed.
        // A successful session always wins over that potentially stale status.
        if case .supported = availabilityStatus {
            throw HelperError.languagePairNotInstalled(source.minimalIdentifier, target.minimalIdentifier)
        }
        throw error
    }
    let translations = responses.map(\.targetText)

    return TranslationOutput(
        translations: translations,
        source: source.minimalIdentifier,
        target: target.minimalIdentifier
    )
}

@main
private struct MacOSTranslationHelper {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            fail("Apple Translation provider requires macOS 26 or later.")
        }

        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            let input = try JSONDecoder().decode(TranslationInput.self, from: data)
            let output = try await translate(input)
            let encoded = try JSONEncoder().encode(output)
            FileHandle.standardOutput.write(encoded)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            fail(error.localizedDescription)
        }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("macOS Translation: \(message)\n".utf8))
        Darwin.exit(1)
    }
}

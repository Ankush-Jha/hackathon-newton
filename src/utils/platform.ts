// src/utils/platform.ts
// Platform compatibility checker for Newton School extension

export interface PlatformCheck {
    supported: boolean;
    message: string;
}

/**
 * Checks if the current platform supports the Newton MCP server.
 * Currently, @newtonschool/newton-mcp only supports macOS Apple Silicon.
 */
export function checkPlatform(): PlatformCheck {
    if (process.platform !== 'darwin') {
        return {
            supported: false,
            message:
                `Newton School MCP currently requires macOS. ` +
                `You're on ${getPlatformName(process.platform)}. ` +
                `Windows and Linux support is coming soon!`,
        };
    }

    // Apple Silicon check is optional — x64 macOS may work via Rosetta
    return { supported: true, message: '' };
}

function getPlatformName(platform: string): string {
    switch (platform) {
        case 'win32':
            return 'Windows';
        case 'linux':
            return 'Linux';
        case 'darwin':
            return 'macOS';
        default:
            return platform;
    }
}

return {
    {
        "bjarneo/aether.nvim",
        name = "aether",
        priority = 1000,
        opts = {
            disable_italics = false,
            -- transparent = true,
            colors = {
                -- Monotone shades (base00-base07)
                base00 = "#070617", -- Default background
                base01 = "#312e55", -- Lighter background (status bars)
                base02 = "#070617", -- Selection background
                base03 = "#312e55", -- Comments, invisibles
                base04 = "#979898", -- Dark foreground
                base05 = "#c5c6c6", -- Default foreground
                base06 = "#c5c6c6", -- Light foreground
                base07 = "#979898", -- Light background

                -- Accent colors (base08-base0F)
                base08 = "#BE4D69", -- Variables, errors, red
                base09 = "#BE4D69", -- Integers, constants, orange
                base0A = "#c99b4a", -- Classes, types, yellow
                base0B = "#2A8669", -- Strings, green
                base0C = "#67c0d7", -- Support, regex, cyan
                base0D = "#4541e1", -- Functions, keywords, blue
                base0E = "#c56bc5", -- Keywords, storage, magenta
                base0F = "#c99b4a", -- Deprecated, brown/yellow
            },
        },
        config = function(_, opts)
            require("aether").setup(opts)
            vim.cmd.colorscheme("aether")

            -- Enable hot reload
            require("aether.hotreload").setup()
        end,
    },
    {
        "LazyVim/LazyVim",
        opts = {
            colorscheme = "aether",
        },
    },
}

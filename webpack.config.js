'use strict';

const path = require('path');
const webpack = require('webpack');

const base = {
    mode: 'none',
    entry: './src/extension.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
        devtoolModuleFilenameTemplate: '../[resource-path]'
    },
    devtool: 'source-map',
    externals: {
        vscode: 'commonjs vscode'
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [{ loader: 'ts-loader' }]
            }
        ]
    }
};

const webConfig = {
    ...base,
    target: 'webworker',
    resolve: {
        mainFields: ['browser', 'module', 'main'],
        extensions: ['.ts', '.js'],
        fallback: {
            assert: require.resolve('assert'),
            path: require.resolve('path-browserify')
        }
    },
    plugins: [new webpack.ProvidePlugin({ process: 'process/browser' })]
};

// One bundle for desktop and web: the webworker build only uses workspace.fs and has no Node requires.
module.exports = webConfig;

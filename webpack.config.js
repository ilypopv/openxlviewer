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
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            use: [{ loader: 'ts-loader' }]
        }]
    }
};

const nodeConfig = {
    ...base,
    target: 'node',
    resolve: { extensions: ['.ts', '.js'] }
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
    plugins: [
        new webpack.ProvidePlugin({ process: 'process/browser' })
    ]
};

module.exports = [nodeConfig, webConfig];

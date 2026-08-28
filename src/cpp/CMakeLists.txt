add_compile_flags_target(${PROJECT_NAME})

target_include_directories(${PROJECT_NAME} PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

target_sources_local(${PROJECT_NAME}
    PRIVATE
        util/HttpClient.cpp # put first because it is soooo slow

        app/BlockEncoder.cpp
        app/Cfg.cpp
        app/check_blocks.cpp
        app/Chunk.cpp
        app/decode_change.cpp
        app/fetchAllBlockHeaders.cpp
        app/find_distant_color.cpp
        app/Hud.cpp
        app/load_all_block_headers.cpp
        app/parse_block.cpp
        app/show_block_changes.cpp
        app/show_pixels_blocks.cpp
        app/utxo_explorer.cpp
        app/utxo_history.cpp
        app/utxo_to_change.cpp
        app/Utxo.cpp
        app/Visualizer.cpp
        buv/SocketStream.cpp
        util/args.cpp
        util/BlockHeightProgressBar.cpp
        util/doctest.cpp
        util/hex.cpp
        util/kbhit.cpp
        util/Mmap.cpp
        util/nanobench.cpp
        util/parallelToSequential.cpp
        util/rss.cpp
)

# The pinned doctest release does not link cleanly with current Apple libc++.
# Keep the application build available on macOS while retaining the full test
# suite on Linux, including the Docker build used for deployment.
if(NOT APPLE)
    target_sources_local(${PROJECT_NAME}
        PRIVATE
            unit/BlockEncoderTest.cpp
            unit/ChunkTest.cpp
            unit/HexTest.cpp
            unit/OpenCVTest.cpp
            unit/parallelToSequentialTest.cpp
            unit/ProgressBarTest.cpp
            unit/VarIntTest.cpp
    )
endif()
